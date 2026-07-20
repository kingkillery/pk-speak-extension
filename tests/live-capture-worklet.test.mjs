import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/remote/live-capture-worklet.js", import.meta.url), "utf8");

function renderOneSecond(inputSampleRate) {
	let Processor;
	const messages = [];
	class AudioWorkletProcessor {
		constructor() {
			this.port = { postMessage: (message) => messages.push(message) };
		}
	}
	vm.runInNewContext(source, {
		AudioWorkletProcessor,
		Float32Array,
		sampleRate: inputSampleRate,
		registerProcessor(_name, implementation) {
			Processor = implementation;
		},
	});
	const processor = new Processor();
	let remaining = inputSampleRate;
	while (remaining > 0) {
		const length = Math.min(128, remaining);
		processor.process([[new Float32Array(length).fill(0.25)]]);
		remaining -= length;
	}
	return messages.reduce((total, chunk) => total + chunk.length, 0) + processor.outputSamples.length;
}

test("AudioWorklet resampling preserves one-second duration at common device rates", () => {
	for (const inputRate of [48_000, 44_100, 16_000, 8_000]) {
		const outputSamples = renderOneSecond(inputRate);
		assert.ok(Math.abs(outputSamples - 16_000) <= 2, `${inputRate} Hz produced ${outputSamples} samples`);
	}
});
