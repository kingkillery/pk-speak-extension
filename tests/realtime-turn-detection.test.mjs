import test from "node:test";
import assert from "node:assert/strict";

import {
	buildGeminiRealtimeInputConfig,
	buildOpenAiTurnDetection,
	resolveRealtimeTurnDetection,
} from "../dist/realtime-turn-detection.js";

test("default profile is wire-identical to the historical behavior", () => {
	const profile = resolveRealtimeTurnDetection({});
	assert.equal(profile.kind, "server_vad");
	// OpenAI: bare server_vad, no extra keys.
	assert.deepEqual(buildOpenAiTurnDetection(profile), { type: "server_vad" });
	// Gemini: no realtimeInputConfig at all.
	assert.equal(buildGeminiRealtimeInputConfig(profile), undefined);
});

test("semantic profile maps to semantic_vad with eagerness and Gemini end sensitivity", () => {
	const profile = resolveRealtimeTurnDetection({
		PI_SPEAK_REALTIME_TURN_DETECTION: "semantic_vad",
		PI_SPEAK_REALTIME_VAD_EAGERNESS: "low",
	});
	assert.deepEqual(buildOpenAiTurnDetection(profile), { type: "semantic_vad", eagerness: "low" });
	assert.deepEqual(buildGeminiRealtimeInputConfig(profile), {
		automaticActivityDetection: { endOfSpeechSensitivity: "END_SENSITIVITY_LOW" },
	});
});

test("eagerness high maps to Gemini END_SENSITIVITY_HIGH; medium and auto add nothing", () => {
	const high = resolveRealtimeTurnDetection({ PI_SPEAK_REALTIME_VAD_EAGERNESS: "high" });
	assert.deepEqual(buildGeminiRealtimeInputConfig(high), {
		automaticActivityDetection: { endOfSpeechSensitivity: "END_SENSITIVITY_HIGH" },
	});
	for (const eagerness of ["medium", "auto"]) {
		const profile = resolveRealtimeTurnDetection({ PI_SPEAK_REALTIME_VAD_EAGERNESS: eagerness });
		assert.equal(buildGeminiRealtimeInputConfig(profile), undefined);
	}
});

test("server_vad tunables pass through with clamping and reach both backends", () => {
	const profile = resolveRealtimeTurnDetection({
		PI_SPEAK_REALTIME_VAD_THRESHOLD: "1.7",
		PI_SPEAK_REALTIME_VAD_PREFIX_MS: "-50",
		PI_SPEAK_REALTIME_VAD_SILENCE_MS: "1200",
	});
	assert.deepEqual(buildOpenAiTurnDetection(profile), {
		type: "server_vad",
		threshold: 1,
		prefix_padding_ms: 0,
		silence_duration_ms: 1200,
	});
	assert.deepEqual(buildGeminiRealtimeInputConfig(profile), {
		automaticActivityDetection: { prefixPaddingMs: 0, silenceDurationMs: 1200 },
	});
});

test("invalid numeric and eagerness values are dropped, not passed through", () => {
	const profile = resolveRealtimeTurnDetection({
		PI_SPEAK_REALTIME_VAD_THRESHOLD: "loud",
		PI_SPEAK_REALTIME_VAD_SILENCE_MS: "forever",
		PI_SPEAK_REALTIME_VAD_EAGERNESS: "extreme",
	});
	assert.deepEqual(buildOpenAiTurnDetection(profile), { type: "server_vad" });
	assert.equal(buildGeminiRealtimeInputConfig(profile), undefined);
});

test("none disables OpenAI turn detection but never disables Gemini auto VAD", () => {
	const profile = resolveRealtimeTurnDetection({ PI_SPEAK_REALTIME_TURN_DETECTION: "none" });
	assert.equal(buildOpenAiTurnDetection(profile), null);
	// Gemini clients send no manual activity markers, so "none" must fall back
	// to automatic detection instead of deadlocking every turn.
	assert.equal(buildGeminiRealtimeInputConfig(profile), undefined);
});

test("none with pause tunables still forwards them to Gemini's automatic VAD", () => {
	const profile = resolveRealtimeTurnDetection({
		PI_SPEAK_REALTIME_TURN_DETECTION: "none",
		PI_SPEAK_REALTIME_VAD_SILENCE_MS: "900",
	});
	assert.equal(buildOpenAiTurnDetection(profile), null);
	assert.deepEqual(buildGeminiRealtimeInputConfig(profile), {
		automaticActivityDetection: { silenceDurationMs: 900 },
	});
});
