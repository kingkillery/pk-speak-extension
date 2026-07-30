import test from "node:test";
import assert from "node:assert/strict";
import {
	approvalControlType,
	buildRealtimeWebSocketUrl,
	decodeLivePcmFrame,
	encodeLivePcmFrame,
	isLoopbackHostname,
	loadPersistedSettings,
	prepareBargeInDetectorForCapture,
	persistSettingsSnapshot,
	STORAGE_AUDIO,
	STORAGE_AUTOPLAY,
	STORAGE_REMEMBER,
	STORAGE_TOKEN,
} from "../web/remote/app.js";
import { createBargeInDetector } from "../web/remote/barge-in-detector.js";

test("buildRealtimeWebSocketUrl maps http origins to websocket live route", () => {
	assert.equal(
		buildRealtimeWebSocketUrl("http://127.0.0.1:8767", "token-1"),
		"ws://127.0.0.1:8767/v1/live?token=token-1",
	);
	assert.equal(
		buildRealtimeWebSocketUrl("https://example.tailnet.ts.net", ""),
		"wss://example.tailnet.ts.net/v1/live",
	);
});

test("desktop loopback hosts bypass remote-token onboarding", () => {
	for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
		assert.equal(isLoopbackHostname(host), true, host);
	}
	assert.equal(isLoopbackHostname("100.64.0.1"), false);
	assert.equal(isLoopbackHostname("127.0.0.42"), false);
	assert.equal(isLoopbackHostname("desktop.example.com"), false);
});

test("realtime PCM framing downsamples mic audio and preserves the sequence header", () => {
	const input = new Float32Array(48).fill(0.5);
	const frame = encodeLivePcmFrame(7, input, 48_000);
	assert.equal(frame.byteLength, 4 + 16 * 2);
	const decoded = decodeLivePcmFrame(frame);
	assert.ok(decoded);
	assert.equal(decoded.sequenceId, 7);
	assert.equal(decoded.samples.length, 16);
	assert.ok(Math.abs(decoded.samples[0] - 0.5) < 0.001);
});

test("realtime PCM framing safely upsamples low-rate input", () => {
	const frame = encodeLivePcmFrame(8, new Float32Array([0.25, -0.25]), 8_000);
	const decoded = decodeLivePcmFrame(frame);
	assert.ok(decoded);
	assert.equal(decoded.samples.length, 4);
});

test("realtime PCM decoder rejects malformed frames", () => {
	assert.equal(decodeLivePcmFrame(new ArrayBuffer(5)), null);
	assert.throws(() => encodeLivePcmFrame(0, new Float32Array([0]), 48_000), /sequence ID/i);
});

test("query token boots into session-first auth state", () => {
	const settings = loadPersistedSettings({
		queryToken: "fresh-token",
		sessionToken: "",
		localToken: "old-token",
		rememberToken: false,
		audio: "true",
		autoplay: "false",
	});
	assert.equal(settings.token, "fresh-token");
	assert.equal(settings.rememberToken, false);
	assert.equal(settings.wantAudio, true);
	assert.equal(settings.autoplay, false);
	assert.equal(settings.shouldPersistQueryToken, true);
});

test("remember-device persistence only stores local token when enabled", () => {
	const remembered = persistSettingsSnapshot({
		token: "persisted-token",
		wantAudio: false,
		autoplay: true,
		rememberToken: true,
	});
	assert.deepEqual(remembered.session, { [STORAGE_TOKEN]: "persisted-token" });
	assert.equal(remembered.local[STORAGE_TOKEN], "persisted-token");
	assert.equal(remembered.local[STORAGE_REMEMBER], "true");
	assert.equal(remembered.local[STORAGE_AUDIO], "false");
	assert.equal(remembered.local[STORAGE_AUTOPLAY], "true");

	const sessionOnly = persistSettingsSnapshot({
		token: "session-token",
		wantAudio: true,
		autoplay: false,
		rememberToken: false,
	});
	assert.deepEqual(sessionOnly.session, { [STORAGE_TOKEN]: "session-token" });
	assert.equal(sessionOnly.clearLocalToken, true);
	assert.equal(sessionOnly.local[STORAGE_REMEMBER], "false");
});

test("live approvals select terminal versus command control messages", () => {
	assert.equal(approvalControlType({ name: "execute_terminal_command" }, true), "terminal_approve");
	assert.equal(approvalControlType({ name: "execute_terminal_command" }, false), "terminal_reject");
	assert.equal(approvalControlType({ name: "launch_agent", reason: "launch_agent" }, true), "command_approve");
	assert.equal(approvalControlType({ name: "archive_session", reason: "archive_session" }, false), "command_reject");
	assert.equal(approvalControlType({ name: "chat_agent" }, true), "command_approve");
});

test("new microphone capture resets ambient learning and reapplies the live gate", () => {
	const detector = createBargeInDetector({
		calibrationFrames: 2,
		absoluteFloor: 0.01,
		absoluteInterruptFloor: 0.015,
		speechMargin: 0.01,
		interruptMargin: 0.01,
		voicedFramesRequired: 2,
	});
	detector.observe({ rms: 0.01, nowMs: 0, aiPlaying: false });
	detector.observe({ rms: 0.01, nowMs: 40, aiPlaying: false });
	assert.equal(detector.getState().framesSeen, 2);

	prepareBargeInDetectorForCapture(detector, { enabled: true, thresholdDb: -40 });
	assert.equal(detector.getState().framesSeen, 0);
	assert.ok(Math.abs(detector.getState().gateThresholdLin - 0.01) < 0.000001);

	// A louder new room is calibration only; it cannot inherit the quiet room's
	// threshold and immediately barge in.
	assert.equal(detector.observe({ rms: 0.08, nowMs: 80, aiPlaying: true }).interrupt, false);
	assert.equal(detector.observe({ rms: 0.08, nowMs: 120, aiPlaying: true }).interrupt, false);
	assert.ok(detector.getState().noiseFloor >= 0.079);
});
