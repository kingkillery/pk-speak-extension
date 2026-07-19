import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

const { waitForSpeakPlaybackGate } = await import("../dist/speak-gate.js");

test("enter playback gate rejects promptly when cancelled", async () => {
	const input = new PassThrough();
	Object.defineProperty(input, "isTTY", { value: true });
	const output = new PassThrough();
	const controller = new AbortController();
	const pending = waitForSpeakPlaybackGate("enter", {
		inputStream: input,
		outputStream: output,
		signal: controller.signal,
	});

	controller.abort();
	await assert.rejects(pending, /abort/i);
});
