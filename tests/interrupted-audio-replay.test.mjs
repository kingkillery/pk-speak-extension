import test from "node:test";
import assert from "node:assert/strict";
import { InterruptedAudioReplay } from "../web/remote/replay-capture.js";

function samples(...values) {
	return new Float32Array(values);
}

test("empty interrupt does not create replay audio", () => {
	const replay = new InterruptedAudioReplay({ maxSamples: 8 });
	assert.equal(replay.freezeInterrupted(), false);
	assert.equal(replay.getReplay(), null);
});

test("capture is bounded without copying full received chunks", () => {
	const replay = new InterruptedAudioReplay({ maxSamples: 3 });
	const first = samples(0.1, 0.2);
	const second = samples(0.3, 0.4);
	replay.capture(first, 24_000);
	replay.capture(second, 24_000);
	assert.equal(replay.currentSamples, 3);
	assert.strictEqual(replay.currentChunks[0], first);
	assert.deepEqual(replay.currentChunks[1], samples(0.3));
});

test("duplicate interrupt preserves the first stable snapshot and drops residual audio", () => {
	const replay = new InterruptedAudioReplay();
	replay.capture(samples(0.1, 0.2), 24_000);
	assert.equal(replay.freezeInterrupted(), true);
	replay.capture(samples(0.9), 24_000);
	assert.equal(replay.freezeInterrupted(), false);
	assert.deepEqual(replay.getReplay().chunks[0], samples(0.1, 0.2));
	assert.equal(replay.currentSamples, 0);
});

test("a later interrupted segment replaces the replay snapshot", () => {
	const replay = new InterruptedAudioReplay();
	replay.capture(samples(0.1), 24_000);
	replay.freezeInterrupted();
	replay.beginSegment();
	replay.capture(samples(0.7, 0.8), 16_000);
	replay.freezeInterrupted();
	const frozen = replay.getReplay();
	assert.equal(frozen.rate, 16_000);
	assert.deepEqual(frozen.chunks[0], samples(0.7, 0.8));
});

test("replay buffers are immutable snapshots with their captured rate", () => {
	const replay = new InterruptedAudioReplay();
	const received = samples(0.2, 0.4);
	replay.capture(received, 22_050);
	replay.freezeInterrupted();
	received[0] = 0.9;
	const firstReplay = replay.getReplay();
	firstReplay.chunks[0][1] = 0.8;
	const secondReplay = replay.getReplay();
	assert.equal(secondReplay.rate, 22_050);
	assert.deepEqual(secondReplay.chunks[0], samples(0.2, 0.4));
});
