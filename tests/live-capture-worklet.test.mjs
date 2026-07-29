import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const captureSource = readFileSync(new URL("../web/remote/live-capture-worklet.js", import.meta.url), "utf8");
const playbackSource = readFileSync(new URL("../web/remote/live-playback-worklet.js", import.meta.url), "utf8");

function loadCaptureProcessor(inputSampleRate) {
	let Processor;
	const messages = [];
	class AudioWorkletProcessor {
		constructor() {
			this.port = {
				onmessage: null,
				postMessage: (message) => messages.push(message),
			};
		}
	}
	vm.runInNewContext(captureSource, {
		AudioWorkletProcessor,
		Float32Array,
		Int16Array,
		Math,
		sampleRate: inputSampleRate,
		registerProcessor(_name, implementation) {
			Processor = implementation;
		},
	});
	return { Processor, messages };
}

function loadPlaybackProcessor(contextRate) {
	let Processor;
	const messages = [];
	class AudioWorkletProcessor {
		constructor() {
			this.port = {
				onmessage: null,
				postMessage: (message) => messages.push(message),
			};
		}
	}
	vm.runInNewContext(playbackSource, {
		AudioWorkletProcessor,
		Float32Array,
		Math,
		sampleRate: contextRate,
		registerProcessor(_name, implementation) {
			Processor = implementation;
		},
	});
	return { Processor, messages };
}

function renderOneSecondCapture(inputSampleRate) {
	const { Processor, messages } = loadCaptureProcessor(inputSampleRate);
	const processor = new Processor({ processorOptions: { chunkMs: 40 } });
	let remaining = inputSampleRate;
	while (remaining > 0) {
		const length = Math.min(128, remaining);
		processor.process([[new Float32Array(length).fill(0.25)]]);
		remaining -= length;
	}
	const pcmChunks = messages.filter((m) => m instanceof ArrayBuffer);
	const sampleCount = pcmChunks.reduce((total, buf) => total + buf.byteLength / 2, 0);
	const levels = messages.filter((m) => m && typeof m === "object" && m.kind === "level");
	return { sampleCount, levels, pcmChunks };
}

test("HF-style capture worklet resamples one second to ~16 kHz Int16 at common device rates", () => {
	for (const inputRate of [48_000, 44_100, 16_000]) {
		const { sampleCount, levels, pcmChunks } = renderOneSecondCapture(inputRate);
		assert.ok(pcmChunks.length > 0, `${inputRate} Hz produced no PCM chunks`);
		assert.ok(Math.abs(sampleCount - 16_000) <= 80, `${inputRate} Hz produced ${sampleCount} samples`);
		assert.ok(levels.length > 0, `${inputRate} Hz produced no level events`);
	}
});

test("capture worklet mute via enable:false still emits levels but no PCM", () => {
	const { Processor, messages } = loadCaptureProcessor(48_000);
	const processor = new Processor({ processorOptions: { chunkMs: 40 } });
	processor.port.onmessage({ data: { kind: "enable", value: false } });
	processor.process([[new Float32Array(4800).fill(0.5)]]);
	const pcm = messages.filter((m) => m instanceof ArrayBuffer);
	const levels = messages.filter((m) => m && m.kind === "level");
	assert.equal(pcm.length, 0);
	assert.ok(levels.length > 0);
});

test("playback worklet accepts audio and clears on barge-in", () => {
	const { Processor, messages } = loadPlaybackProcessor(48_000);
	const processor = new Processor();
	// Simulate the main-thread wiring: port.onmessage is set in constructor.
	processor.port.onmessage({ data: { kind: "config", inputRate: 24_000 } });
	const samples = new Float32Array(2400).fill(0.1);
	processor.port.onmessage({ data: { kind: "audio", samples } });
	const out = [new Float32Array(128)];
	processor.process(null, [out]);
	assert.ok(out[0].some((v) => v !== 0), "expected non-silent playback output");
	const started = messages.find((message) => message?.kind === "playback_started");
	assert.ok(started, "expected exact first-render signal");
	assert.ok(Number.isFinite(started.contextTimeSeconds));
	processor.port.onmessage({ data: { kind: "clear" } });
	// After clear + fade, later frames trend toward silence.
	for (let i = 0; i < 20; i++) processor.process(null, [out]);
	const absMax = Math.max(...out[0].map((v) => Math.abs(v)));
	assert.ok(absMax < 0.05, `expected near-silent after clear, got ${absMax}`);
	const cleared = messages.find((message) => message?.kind === "cleared");
	assert.ok(cleared, "expected audio-thread clear completion signal");
	assert.ok(Number.isFinite(cleared.contextTimeSeconds));
	void messages;
});
