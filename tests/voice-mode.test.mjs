import test from "node:test";
import assert from "node:assert/strict";
import {
	VOICE_MODES,
	describeVoiceMode,
	nextVoiceMode,
	normalizeVoiceMode,
	resolveVoiceMode,
	voiceModeStatusLabel,
	voiceModeTargets,
} from "../dist/voice-mode.js";

test("voiceModeTargets maps each mode to concrete switches", () => {
	assert.deepEqual(voiceModeTargets("off"), { speakEnabled: false, sttEnabled: false, realtime: false });
	assert.deepEqual(voiceModeTargets("tts"), { speakEnabled: true, sttEnabled: false, realtime: false });
	assert.deepEqual(voiceModeTargets("stt"), { speakEnabled: false, sttEnabled: true, realtime: false });
	assert.deepEqual(voiceModeTargets("combo"), { speakEnabled: true, sttEnabled: true, realtime: false });
	assert.deepEqual(voiceModeTargets("realtime"), { speakEnabled: false, sttEnabled: false, realtime: true });
});

test("realtime stands the local turn-based loop down", () => {
	const targets = voiceModeTargets("realtime");
	assert.equal(targets.speakEnabled, false, "realtime must not leave local TTS speaking over the live client");
	assert.equal(targets.sttEnabled, false, "realtime must not leave the wake listener fighting the live mic");
	assert.equal(targets.realtime, true);
});

test("resolveVoiceMode derives display mode from actual switches", () => {
	assert.equal(resolveVoiceMode({ speakEnabled: false, sttEnabled: false, realtime: false }), "off");
	assert.equal(resolveVoiceMode({ speakEnabled: true, sttEnabled: false, realtime: false }), "tts");
	assert.equal(resolveVoiceMode({ speakEnabled: false, sttEnabled: true, realtime: false }), "stt");
	assert.equal(resolveVoiceMode({ speakEnabled: true, sttEnabled: true, realtime: false }), "combo");
	assert.equal(resolveVoiceMode({ speakEnabled: true, sttEnabled: true, realtime: true }), "realtime", "realtime wins over stray switches");
});

test("combo and realtime are distinct modes", () => {
	assert.notEqual(resolveVoiceMode({ speakEnabled: true, sttEnabled: true, realtime: false }), "realtime");
	assert.equal(resolveVoiceMode({ speakEnabled: true, sttEnabled: true, realtime: false }), "combo");
});

test("normalizeVoiceMode restores known modes and defaults unknown to off", () => {
	for (const mode of VOICE_MODES) {
		assert.equal(normalizeVoiceMode(mode), mode);
	}
	assert.equal(normalizeVoiceMode("banana"), "off");
	assert.equal(normalizeVoiceMode(undefined), "off");
	assert.equal(normalizeVoiceMode(42), "off");
	assert.equal(normalizeVoiceMode(null), "off");
});

test("nextVoiceMode cycles through every mode and wraps", () => {
	assert.equal(nextVoiceMode("off"), "tts");
	assert.equal(nextVoiceMode("tts"), "stt");
	assert.equal(nextVoiceMode("stt"), "combo");
	assert.equal(nextVoiceMode("combo"), "realtime");
	assert.equal(nextVoiceMode("realtime"), "off");
	// Full cycle returns to start.
	let mode = "off";
	for (let i = 0; i < VOICE_MODES.length; i++) mode = nextVoiceMode(mode);
	assert.equal(mode, "off");
});

test("status label hides when off and flags unconfigured realtime", () => {
	assert.equal(voiceModeStatusLabel("off"), "");
	assert.equal(voiceModeStatusLabel("tts"), "voice:tts");
	assert.equal(voiceModeStatusLabel("stt"), "voice:stt");
	assert.equal(voiceModeStatusLabel("combo"), "voice:combo");
	assert.equal(voiceModeStatusLabel("realtime", true), "voice:realtime");
	assert.equal(voiceModeStatusLabel("realtime", false), "voice:realtime (setup needed)");
});

test("describeVoiceMode distinguishes turn-based combo from realtime", () => {
	assert.match(describeVoiceMode("combo"), /turn-based/i);
	assert.match(describeVoiceMode("combo"), /not realtime/i);
	assert.match(describeVoiceMode("realtime"), /Gemini Live/i);
	assert.match(describeVoiceMode("off"), /off/i);
});
