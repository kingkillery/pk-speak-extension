import { analyzeVoiceMetrics, generateMarkdownTable } from "./analyze-voice-metrics.mjs";
import assert from "node:assert/strict";

const syntheticLogs = [
	// Gemini Config A (20 turns, 5 barge-ins)
	...Array.from({ length: 20 }, (_, i) => ({
		kind: "turn",
		provider: "gemini",
		model: "gemini-2.0-flash-exp",
		turnDetection: "server_vad",
		vadSpeechEndClientMs: 1000 + i * 100,
		lastPcmSentUpstreamMs: 1000 + i * 100,
		firstUpstreamEventMs: 1200 + i * 100 + (i % 3) * 10,
		firstPcmEnqueuedClientMs: 1220 + i * 100 + (i % 3) * 10,
		firstSampleRenderedClientMs: 1230 + i * 100 + (i % 3) * 10,
		timeToFirstAudioMs: 230 + (i % 3) * 10,
		upstreamInferenceMs: 200 + (i % 3) * 10,
		localBufferMs: 10,
	})),
	...Array.from({ length: 5 }, (_, i) => ({
		kind: "barge_in",
		provider: "gemini",
		model: "gemini-2.0-flash-exp",
		turnDetection: "server_vad",
		speechOnsetClientMs: 5000 + i * 200,
		playbackSilencedClientMs: 5055 + i * 200 + (i * 2),
		speechOnsetToSilenceMs: 55 + (i * 2),
	})),

	// OpenAI Config B: Server VAD Default (20 turns, 5 barge-ins)
	...Array.from({ length: 20 }, (_, i) => ({
		kind: "turn",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "server_vad",
		eagerness: "default",
		timeToFirstAudioMs: 310 + (i % 4) * 15,
		upstreamInferenceMs: 280 + (i % 4) * 15,
		localBufferMs: 12,
	})),
	...Array.from({ length: 5 }, (_, i) => ({
		kind: "barge_in",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "server_vad",
		eagerness: "default",
		speechOnsetToSilenceMs: 62 + i * 3,
	})),

	// OpenAI Config C: Semantic VAD Low Eagerness / Patient (20 turns, 5 barge-ins)
	...Array.from({ length: 20 }, (_, i) => ({
		kind: "turn",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "semantic_vad",
		eagerness: "low",
		timeToFirstAudioMs: 420 + (i % 5) * 20,
		upstreamInferenceMs: 390 + (i % 5) * 20,
		localBufferMs: 15,
	})),
	...Array.from({ length: 5 }, (_, i) => ({
		kind: "barge_in",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "semantic_vad",
		eagerness: "low",
		speechOnsetToSilenceMs: 70 + i * 4,
	})),

	// OpenAI Config D: Semantic VAD High Eagerness / Snappy (20 turns, 5 barge-ins)
	...Array.from({ length: 20 }, (_, i) => ({
		kind: "turn",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "semantic_vad",
		eagerness: "high",
		timeToFirstAudioMs: 250 + (i % 3) * 10,
		upstreamInferenceMs: 220 + (i % 3) * 10,
		localBufferMs: 10,
	})),
	...Array.from({ length: 5 }, (_, i) => ({
		kind: "barge_in",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "semantic_vad",
		eagerness: "high",
		speechOnsetToSilenceMs: 50 + i * 2,
	})),
];

const results = analyzeVoiceMetrics(syntheticLogs);
assert.equal(results.length, 4, "Expected 4 configuration groups");

const geminiGroup = results.find((r) => r.provider === "gemini");
assert.ok(geminiGroup, "Gemini group must exist");
assert.equal(geminiGroup.turns, 20);
assert.equal(geminiGroup.bargeIns, 5);
assert.equal(geminiGroup.status, "**PASS**");

const mdTable = generateMarkdownTable(results);
console.log("=== SYNTHETIC METRICS ANALYZER TEST ===");
console.log(mdTable);
console.log("✅ Synthetic analyzer test PASSED!");
