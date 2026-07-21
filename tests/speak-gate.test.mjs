import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

const { waitForSpeakPlaybackGate, resolveSpeakPlaybackGate, normalizeSpeakPlaybackGate, describeSpeakPlaybackGate } = await import("../dist/speak-gate.js");

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

test("orb gate is the new default and never blocks stdin", async () => {
	// No env, no cli flag, no config → orb (interactive UI, no autoplay).
	assert.equal(resolveSpeakPlaybackGate({}), "orb");
	assert.equal(resolveSpeakPlaybackGate({ env: {} }), "orb");
	// Describe surfaces the no-autoplay intent for status prints.
	assert.match(describeSpeakPlaybackGate("orb"), /no autoplay/i);
	// orb never prompts stdin: the operator's controls live in the orb window.
	const result = await waitForSpeakPlaybackGate("orb", {});
	assert.equal(result, "passed");
});

test("normalizeSpeakPlaybackGate accepts orb aliases and preserves legacy 'off'->immediate", () => {
	assert.equal(normalizeSpeakPlaybackGate("orb"), "orb");
	assert.equal(normalizeSpeakPlaybackGate("UI"), "orb");
	assert.equal(normalizeSpeakPlaybackGate("interactive"), "orb");
	// Legacy 'off'/'none' configs meant auto-play semantics at the time, so
	// they keep mapping to immediate rather than silently switching behavior.
	assert.equal(normalizeSpeakPlaybackGate("off"), "immediate");
	assert.equal(normalizeSpeakPlaybackGate("none"), "immediate");
	assert.equal(normalizeSpeakPlaybackGate("auto"), "immediate");
	// Unknown values stay undefined so resolveSpeakPlaybackGate falls through.
	assert.equal(normalizeSpeakPlaybackGate("garbage"), undefined);
});

test("explicit env override wins over orb default", () => {
	assert.equal(resolveSpeakPlaybackGate({ env: { PI_SPEAK_PLAYBACK_GATE: "immediate" } }), "immediate");
	assert.equal(resolveSpeakPlaybackGate({ env: { PI_SPEAK_PLAYBACK_GATE: "enter" } }), "enter");
	assert.equal(resolveSpeakPlaybackGate({ env: { PI_SPEAK_PLAYBACK_GATE: "orb" } }), "orb");
	// CLI flag beats env.
	assert.equal(resolveSpeakPlaybackGate({ cliGate: "immediate", env: { PI_SPEAK_PLAYBACK_GATE: "orb" } }), "immediate");
});
