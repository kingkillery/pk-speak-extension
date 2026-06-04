import test from "node:test";
import assert from "node:assert/strict";
import { withAbortTimeout } from "../dist/request-timeout.js";

test("passes a usable signal through to the callback and returns its result", async () => {
	let received;
	const result = await withAbortTimeout(async (signal) => {
		received = signal;
		return 42;
	});
	assert.equal(result, 42);
	assert.ok(received instanceof AbortSignal);
	assert.equal(received.aborted, false);
});

test("aborts the signal once the timeout elapses", async (t) => {
	// withAbortTimeout unref()s its timer so it can't keep the loop alive; drive
	// the deadline with mock timers rather than a flaky real wall-clock timeout.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = withAbortTimeout(
		(signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
		undefined,
		5,
	);
	t.mock.timers.tick(5);
	await assert.rejects(pending, /timed out/i);
});

test("a caller-provided abort propagates to the combined signal", async () => {
	const controller = new AbortController();
	const pending = withAbortTimeout(
		(signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
		controller.signal,
		10_000,
	);
	controller.abort(new Error("caller cancelled"));
	await assert.rejects(pending, /caller cancelled/);
});

test("a non-positive timeout disables the timer and still runs the callback", async () => {
	const result = await withAbortTimeout(async (signal) => {
		assert.ok(signal instanceof AbortSignal);
		return "ok";
	}, undefined, 0);
	assert.equal(result, "ok");
});

test("the timeout does not fire for fast callbacks", async () => {
	const result = await withAbortTimeout(async () => "fast", undefined, 1000);
	assert.equal(result, "fast");
});
