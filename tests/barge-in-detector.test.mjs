import { test } from "node:test";
import assert from "node:assert/strict";
import { createBargeInDetector, rmsFromInt16 } from "../web/remote/barge-in-detector.js";
import { REALTIME_SYSTEM_PROMPT } from "../dist/realtime-gateway.js";

function drive(detector, frames) {
	return frames.map((frame, index) =>
		detector.observe({
			rms: frame.rms,
			nowMs: frame.nowMs ?? index * 40,
			aiPlaying: frame.aiPlaying ?? false,
			muted: frame.muted ?? false,
		}),
	);
}

test("rmsFromInt16 computes mono RMS", () => {
	const silent = new Int16Array(8);
	assert.equal(rmsFromInt16(silent), 0);
	const loud = Int16Array.from([16000, -16000, 16000, -16000]);
	assert.ok(rmsFromInt16(loud) > 0.4);
});

test("calibration uses quiet percentile and never interrupts", () => {
	const detector = createBargeInDetector({ calibrationFrames: 10, calibrationQuietPercentile: 0.3 });
	// Mostly quiet ambient with a few loud speech frames mixed in.
	const samples = [0.02, 0.03, 0.025, 0.12, 0.02, 0.028, 0.15, 0.03, 0.022, 0.027];
	const decisions = drive(
		detector,
		samples.map((rms, i) => ({ rms, aiPlaying: true, nowMs: i * 40 })),
	);
	assert.equal(decisions.every((d) => d.calibrating), true);
	assert.equal(decisions.some((d) => d.interrupt), false);
	// Quiet percentile should ignore the 0.12/0.15 spikes.
	assert.ok(decisions.at(-1).noiseFloor < 0.05, `noise floor poisoned: ${decisions.at(-1).noiseFloor}`);
});

test("steady room noise from startup does not barge-in after AI starts", () => {
	const detector = createBargeInDetector({ calibrationFrames: 20 });
	drive(
		detector,
		Array.from({ length: 20 }, (_, i) => ({
			rms: 0.065,
			aiPlaying: false,
			nowMs: i * 40,
		})),
	);
	const whileAi = drive(
		detector,
		Array.from({ length: 25 }, (_, i) => ({
			rms: 0.07,
			aiPlaying: true,
			nowMs: 1000 + i * 40,
		})),
	);
	assert.equal(whileAi.some((d) => d.interrupt), false);
	assert.equal(whileAi.some((d) => d.userSpeaking), false);
	const last = whileAi.at(-1);
	assert.ok(last.noiseFloor >= 0.05, `noise floor too low: ${last.noiseFloor}`);
	assert.ok(last.interruptThreshold > 0.07, `interrupt threshold should sit above ambient: ${last.interruptThreshold}`);
});

test("speech during startup does not permanently suppress later quiet barge-ins", () => {
	const detector = createBargeInDetector({ calibrationFrames: 12, calibrationQuietPercentile: 0.3 });
	// User talks immediately after open: mix of quiet ambient + loud speech.
	const startup = [];
	for (let i = 0; i < 12; i += 1) {
		startup.push({
			rms: i % 3 === 0 ? 0.14 : 0.025,
			aiPlaying: false,
			nowMs: i * 40,
		});
	}
	drive(detector, startup);
	// AI starts; ambient remains low.
	drive(
		detector,
		Array.from({ length: 5 }, (_, i) => ({
			rms: 0.03,
			aiPlaying: true,
			nowMs: 1000 + i * 40,
		})),
	);
	// Quiet intentional barge-in should still work.
	const speech = drive(detector, [
		{ rms: 0.08, aiPlaying: true, nowMs: 2000 },
		{ rms: 0.085, aiPlaying: true, nowMs: 2040 },
		{ rms: 0.09, aiPlaying: true, nowMs: 2080 },
	]);
	assert.equal(speech.at(-1).interrupt, true);
});

test("after noisy ambient calibration, louder intentional speech still barges in", () => {
	const detector = createBargeInDetector({ calibrationFrames: 20 });
	drive(
		detector,
		Array.from({ length: 20 }, (_, i) => ({
			rms: 0.06,
			aiPlaying: false,
			nowMs: i * 40,
		})),
	);
	drive(
		detector,
		Array.from({ length: 5 }, (_, i) => ({
			rms: 0.065,
			aiPlaying: true,
			nowMs: 1000 + i * 40,
		})),
	);
	const speech = drive(detector, [
		{ rms: 0.12, aiPlaying: true, nowMs: 2000 },
		{ rms: 0.13, aiPlaying: true, nowMs: 2040 },
		{ rms: 0.14, aiPlaying: true, nowMs: 2080 },
	]);
	assert.equal(speech[0].interrupt, false);
	assert.equal(speech[1].interrupt, false);
	assert.equal(speech[2].interrupt, true);
});

test("ambient noise and short spikes do not barge-in while AI is speaking", () => {
	const detector = createBargeInDetector({ calibrationFrames: 12 });
	drive(detector, Array.from({ length: 12 }, () => ({ rms: 0.02, aiPlaying: false })));
	drive(detector, Array.from({ length: 8 }, () => ({ rms: 0.02, aiPlaying: true })));
	const spike = drive(detector, [
		{ rms: 0.09, aiPlaying: true, nowMs: 2000 },
		{ rms: 0.02, aiPlaying: true, nowMs: 2040 },
		{ rms: 0.02, aiPlaying: true, nowMs: 2080 },
	]);
	assert.equal(spike.some((d) => d.interrupt), false);
});

test("sustained quiet speech barges in after required voiced frames in a quiet room", () => {
	const detector = createBargeInDetector({ calibrationFrames: 10 });
	drive(detector, Array.from({ length: 10 }, () => ({ rms: 0.015, aiPlaying: false })));
	const decisions = drive(detector, [
		{ rms: 0.055, aiPlaying: true, nowMs: 2000 },
		{ rms: 0.058, aiPlaying: true, nowMs: 2040 },
		{ rms: 0.06, aiPlaying: true, nowMs: 2080 },
	]);
	assert.equal(decisions[0].interrupt, false);
	assert.equal(decisions[1].interrupt, false);
	assert.equal(decisions[2].interrupt, true);
	assert.equal(decisions[2].userSpeaking, true);
});

test("interrupt cooldown prevents immediate re-trigger from residual noise", () => {
	const detector = createBargeInDetector({ cooldownMs: 1200, calibrationFrames: 8 });
	drive(detector, Array.from({ length: 8 }, () => ({ rms: 0.015, aiPlaying: false })));
	const first = drive(detector, [
		{ rms: 0.08, aiPlaying: true, nowMs: 3000 },
		{ rms: 0.08, aiPlaying: true, nowMs: 3040 },
		{ rms: 0.08, aiPlaying: true, nowMs: 3080 },
	]);
	assert.equal(first.at(-1).interrupt, true);

	// Residual noise inside cooldown must not re-fire.
	const second = drive(detector, [
		{ rms: 0.08, aiPlaying: true, nowMs: 3200 },
		{ rms: 0.08, aiPlaying: true, nowMs: 3240 },
		{ rms: 0.08, aiPlaying: true, nowMs: 3280 },
	]);
	assert.equal(second.some((d) => d.interrupt), false);

	// Drop to ambient so release hysteresis clears userSpeaking, then speak again.
	drive(detector, [
		{ rms: 0.01, aiPlaying: true, nowMs: 4000 },
		{ rms: 0.01, aiPlaying: true, nowMs: 4040 },
		{ rms: 0.01, aiPlaying: true, nowMs: 4080 },
	]);
	const afterCooldown = drive(detector, [
		{ rms: 0.08, aiPlaying: true, nowMs: 4500 },
		{ rms: 0.08, aiPlaying: true, nowMs: 4540 },
		{ rms: 0.08, aiPlaying: true, nowMs: 4580 },
	]);
	assert.equal(afterCooldown.at(-1).interrupt, true);
});

test("speech end only fires after release hysteresis", () => {
	const detector = createBargeInDetector({ releaseFrames: 3, calibrationFrames: 5 });
	drive(detector, Array.from({ length: 5 }, () => ({ rms: 0.015, aiPlaying: false })));
	drive(detector, [
		{ rms: 0.07, aiPlaying: false, nowMs: 1000 },
		{ rms: 0.07, aiPlaying: false, nowMs: 1040 },
		{ rms: 0.07, aiPlaying: false, nowMs: 1080 },
	]);
	const release = drive(detector, [
		{ rms: 0.01, aiPlaying: false, nowMs: 1120 },
		{ rms: 0.01, aiPlaying: false, nowMs: 1160 },
		{ rms: 0.01, aiPlaying: false, nowMs: 1200 },
	]);
	assert.equal(release[0].speechEnded, false);
	assert.equal(release[1].speechEnded, false);
	assert.equal(release[2].speechEnded, true);
	assert.equal(release[2].userSpeaking, false);
});

test("noise gate threshold raises the speech floor when enabled", () => {
	const detector = createBargeInDetector({
		absoluteFloor: 0.02,
		absoluteInterruptFloor: 0.03,
		calibrationFrames: 5,
	});
	detector.setGateThresholdDb(-20, true); // ~0.1 linear
	drive(detector, Array.from({ length: 5 }, () => ({ rms: 0.02, aiPlaying: false })));
	const decisions = drive(detector, [
		{ rms: 0.06, aiPlaying: true, nowMs: 1000 },
		{ rms: 0.06, aiPlaying: true, nowMs: 1040 },
		{ rms: 0.06, aiPlaying: true, nowMs: 1080 },
		{ rms: 0.12, aiPlaying: true, nowMs: 1120 },
		{ rms: 0.12, aiPlaying: true, nowMs: 1160 },
		{ rms: 0.12, aiPlaying: true, nowMs: 1200 },
	]);
	assert.equal(decisions.slice(0, 3).some((d) => d.interrupt), false);
	assert.equal(decisions.at(-1).interrupt, true);
});

test("system prompt teaches post-turn acknowledge-and-replan after barge-in", () => {
	assert.match(REALTIME_SYSTEM_PROMPT, /interrupted mid-answer/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /wait until the user finishes speaking/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /mhm|okay|got it/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /reassess/i);
});
