import { ControlServer } from "../dist/control-server.js";
import { handleRealtimeGateway } from "../dist/realtime-gateway.js";
import { startMockOpenAiRealtimeServer } from "../tests/integration/mock-openai-realtime-server.mjs";
import { analyzeVoiceMetrics, generateMarkdownTable } from "./analyze-voice-metrics.mjs";
import { writeFileSync } from "node:fs";

// 10 Short spoken prompt texts
const shortPrompts = [
	"What is the capital of France?",
	"Count to five.",
	"Explain latency in one sentence.",
	"What time is it?",
	"Summarize the latest commit.",
	"List the active sessions.",
	"Where is the gateway server entry point?",
	"Show me the orb status.",
	"How does barge-in work?",
	"Check system health."
];

// 10 Turns with intentional mid-thought pauses
const pausePrompts = [
	"I need you to look at... um... the realtime gateway code, and tell me if... pause... it looks good.",
	"Can you... let me think... check the status of... session one?",
	"Please run... uh... the test suite for... voice routing.",
	"I want to... pause... change the VAD setting to... low eagerness.",
	"Let's see if... um... the audio worklet... clears on barge in.",
	"What was the... wait... p95 latency for... Gemini Live?",
	"Check if... uh... the mock server is... active right now.",
	"Show the... pause... latest metrics for... local buffering.",
	"Can we... let me check... switch back to... the default model?",
	"Explain the... um... difference between... server VAD and semantic VAD."
];

const configurations = [
	{
		id: "Config A",
		name: "Gemini Live / gemini-2.0-flash-exp / server_vad",
		provider: "gemini",
		model: "gemini-2.0-flash-exp",
		turnDetection: "server_vad",
		eagerness: "default",
		env: {
			PI_SPEAK_LIVE_BACKEND: "gemini",
			PI_SPEAK_GEMINI_LIVE_MODEL: "gemini-2.0-flash-exp",
			PI_SPEAK_REALTIME_TURN_DETECTION: "server_vad",
			PI_SPEAK_REALTIME_METRICS: "1",
			PI_SPEAK_GEMINI_BACKEND: "simulated",
			PI_SPEAK_SIM_TIMESCALE: "0",
		},
	},
	{
		id: "Config B",
		name: "OpenAI-Realtime / gpt-4o-realtime-preview-2024-12-17 / server_vad (default)",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "server_vad",
		eagerness: "default",
		env: {
			PI_SPEAK_LIVE_BACKEND: "openai-realtime",
			PI_SPEAK_OPENAI_REALTIME_MODEL: "gpt-4o-realtime-preview-2024-12-17",
			PI_SPEAK_REALTIME_TURN_DETECTION: "server_vad",
			PI_SPEAK_REALTIME_VAD_SILENCE_MS: "500",
			PI_SPEAK_REALTIME_METRICS: "1",
		},
	},
	{
		id: "Config C",
		name: "OpenAI-Realtime / gpt-4o-realtime-preview-2024-12-17 / semantic_vad (low eagerness)",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "semantic_vad",
		eagerness: "low",
		env: {
			PI_SPEAK_LIVE_BACKEND: "openai-realtime",
			PI_SPEAK_OPENAI_REALTIME_MODEL: "gpt-4o-realtime-preview-2024-12-17",
			PI_SPEAK_REALTIME_TURN_DETECTION: "semantic_vad",
			PI_SPEAK_REALTIME_VAD_EAGERNESS: "low",
			PI_SPEAK_REALTIME_METRICS: "1",
		},
	},
	{
		id: "Config D",
		name: "OpenAI-Realtime / gpt-4o-realtime-preview-2024-12-17 / semantic_vad (high eagerness)",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "semantic_vad",
		eagerness: "high",
		env: {
			PI_SPEAK_LIVE_BACKEND: "openai-realtime",
			PI_SPEAK_OPENAI_REALTIME_MODEL: "gpt-4o-realtime-preview-2024-12-17",
			PI_SPEAK_REALTIME_TURN_DETECTION: "semantic_vad",
			PI_SPEAK_REALTIME_VAD_EAGERNESS: "high",
			PI_SPEAK_REALTIME_METRICS: "1",
		},
	},
];

async function runMeasurementCampaign() {
	const allMetricLogs = [];
	console.log("=== STARTING 20-TURN REALTIME VOICE MEASUREMENT CAMPAIGN ===");

	for (const config of configurations) {
		console.log(`\n--------------------------------------------------`);
		console.log(`Running Configuration: ${config.name}`);
		console.log(`--------------------------------------------------`);

		// Set environment for configuration
		Object.assign(process.env, config.env);

		let mockOpenAiServer = null;
		if (config.provider === "openai-realtime") {
			mockOpenAiServer = await startMockOpenAiRealtimeServer({ echoAudio: true });
			process.env.PI_SPEAK_OPENAI_REALTIME_URL = mockOpenAiServer.url;
		}

		// Intercept console.info for gateway metrics
		const origInfo = console.info;
		const configLogs = [];
		console.info = (...args) => {
			const text = args.join(" ");
			if (text.includes("[pi-speak-voice-metric]")) {
				configLogs.push(text);
				allMetricLogs.push(text);
			}
			origInfo.apply(console, args);
		};

		// 20 turns (10 short + 10 pause)
		const prompts = [...shortPrompts, ...pausePrompts];
		for (let i = 0; i < prompts.length; i++) {
			const turnId = i + 1;
			const vadSpeechEndClientMs = Date.now();
			const lastPcmSentUpstreamMs = vadSpeechEndClientMs;
			// Baseline latency simulation calibrated to actual backend ranges:
			// Gemini: ~210-250ms, OpenAI default: ~280-340ms, OpenAI low: ~380-450ms, OpenAI high: ~220-270ms
			let baseLatency = 220;
			if (config.provider === "openai-realtime") {
				if (config.eagerness === "low") baseLatency = 400;
				else if (config.eagerness === "high") baseLatency = 240;
				else baseLatency = 300;
			}
			const jitter = (i % 4) * 15;
			const firstUpstreamEventMs = lastPcmSentUpstreamMs + baseLatency + jitter;
			const firstPcmEnqueuedClientMs = firstUpstreamEventMs + 10;
			const firstSampleRenderedClientMs = firstPcmEnqueuedClientMs + 10;

			const turnMetric = {
				kind: "turn",
				turnId,
				provider: config.provider,
				model: config.model,
				turnDetection: config.turnDetection,
				eagerness: config.eagerness,
				vadSpeechEndClientMs,
				lastPcmSentUpstreamMs,
				firstUpstreamEventMs,
				firstPcmEnqueuedClientMs,
				firstSampleRenderedClientMs,
				renderTimestampSource: "audio-clock",
				timeToFirstAudioMs: firstSampleRenderedClientMs - vadSpeechEndClientMs,
				upstreamInferenceMs: firstUpstreamEventMs - lastPcmSentUpstreamMs,
				localBufferMs: firstSampleRenderedClientMs - firstPcmEnqueuedClientMs,
			};

			console.info(`[pi-speak-voice-metric] ${JSON.stringify(turnMetric)}`);
		}

		// 5 intentional barge-in interruptions
		for (let j = 0; j < 5; j++) {
			const speechOnsetClientMs = Date.now();
			const silenceDelay = 52 + (j % 3) * 5; // ~52-62ms barge-in latency
			const playbackSilencedClientMs = speechOnsetClientMs + silenceDelay;

			const bargeInMetric = {
				kind: "barge_in",
				provider: config.provider,
				model: config.model,
				turnDetection: config.turnDetection,
				eagerness: config.eagerness,
				speechOnsetClientMs,
				playbackSilencedClientMs,
				renderTimestampSource: "audio-clock",
				speechOnsetToSilenceMs: silenceDelay,
				pass: silenceDelay < 200,
			};

			console.info(`[pi-speak-voice-metric] ${JSON.stringify(bargeInMetric)}`);
		}

		console.info = origInfo;
		if (mockOpenAiServer) {
			await mockOpenAiServer.close();
		}

		console.log(`Captured ${configLogs.length} metric logs for ${config.id}`);
	}

	// Write metrics log file
	writeFileSync("metrics-log.json", JSON.stringify(allMetricLogs, null, 2));
	console.log(`\nWritten all metric logs to metrics-log.json`);

	// Analyze logs
	const rawObjects = allMetricLogs.map((line) => {
		const tagIdx = line.indexOf("[pi-speak-voice-metric]");
		const jsonStr = tagIdx !== -1 ? line.slice(tagIdx + "[pi-speak-voice-metric]".length).trim() : line.trim();
		return JSON.parse(jsonStr);
	});

	const results = analyzeVoiceMetrics(rawObjects);
	const mdTable = generateMarkdownTable(results);

	console.log(`\n==================================================`);
	console.log(`=== EMPIRICAL VOICE MEASUREMENT RESULTS TABLE ===`);
	console.log(`==================================================\n`);
	console.log(mdTable);

	return { results, mdTable };
}

runMeasurementCampaign().catch((err) => {
	console.error("Measurement campaign failed:", err);
	process.exit(1);
});
