import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSpeakMode, isSpeakEnabled } from "../dist/speak-mode.js";

test("normalizeSpeakMode: undefined input falls back to off", () => {
	assert.equal(normalizeSpeakMode(undefined), "off");
});

test("normalizeSpeakMode: legacy enabled:true (no mode) -> on", () => {
	assert.equal(normalizeSpeakMode({ enabled: true }), "on");
});

test("normalizeSpeakMode: legacy enabled:false (no mode) -> off", () => {
	assert.equal(normalizeSpeakMode({ enabled: false }), "off");
});

test("normalizeSpeakMode: empty object (no mode, no enabled) -> off", () => {
	assert.equal(normalizeSpeakMode({}), "off");
});

test("normalizeSpeakMode: explicit mode 'agent' wins", () => {
	assert.equal(normalizeSpeakMode({ mode: "agent" }), "agent");
});

test("normalizeSpeakMode: explicit mode 'on' wins", () => {
	assert.equal(normalizeSpeakMode({ mode: "on" }), "on");
});

test("normalizeSpeakMode: explicit mode 'off' wins over enabled:true", () => {
	assert.equal(normalizeSpeakMode({ mode: "off", enabled: true }), "off");
});

test("normalizeSpeakMode: invalid mode falls back via enabled (true -> on)", () => {
	// Simulate corrupted/unknown persisted mode value; should ignore it and
	// fall back to the legacy enabled boolean.
	assert.equal(
		normalizeSpeakMode({ mode: "loud", enabled: true }),
		"on",
	);
});

test("normalizeSpeakMode: invalid mode falls back via enabled (false -> off)", () => {
	assert.equal(
		normalizeSpeakMode({ mode: "loud", enabled: false }),
		"off",
	);
});

test("normalizeSpeakMode: invalid mode with no enabled -> off", () => {
	assert.equal(normalizeSpeakMode({ mode: "bogus" }), "off");
});

test("isSpeakEnabled: off -> false", () => {
	assert.equal(isSpeakEnabled("off"), false);
});

test("isSpeakEnabled: on -> true", () => {
	assert.equal(isSpeakEnabled("on"), true);
});

test("isSpeakEnabled: agent -> true", () => {
	assert.equal(isSpeakEnabled("agent"), true);
});
