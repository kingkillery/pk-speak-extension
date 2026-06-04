import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalRegistry } from "../dist/voice-approval.js";

test("request resolves to accept when registry.accept() is called", async () => {
	const registry = createApprovalRegistry();
	const promise = registry.request({ description: "bash: ls", timeoutMs: 5000 });
	const entry = registry.get();
	assert.ok(entry, "expected pending entry to exist");
	assert.equal(entry.description, "bash: ls");
	assert.match(entry.spokenPrompt, /Approve bash: ls/);

	registry.accept();
	assert.equal(await promise, "accept");
	assert.equal(registry.get(), undefined, "expected slot to be cleared after accept");
});

test("request resolves to decline when registry.decline() is called", async () => {
	const registry = createApprovalRegistry();
	const promise = registry.request({ description: "edit: file.ts", timeoutMs: 5000 });
	registry.decline();
	assert.equal(await promise, "decline");
	assert.equal(registry.get(), undefined);
});

test("stacked request auto-declines without disturbing the in-flight one", async () => {
	const registry = createApprovalRegistry();
	const first = registry.request({ description: "first", timeoutMs: 5000 });
	const second = await registry.request({ description: "second", timeoutMs: 5000 });
	assert.equal(second, "decline");

	// First is still pending.
	assert.equal(registry.get()?.description, "first");
	registry.accept();
	assert.equal(await first, "accept");
});

test("request resolves to decline after timeout (default onTimeout)", async (t) => {
	// The registry unref()s its timeout timer so it never keeps the event loop
	// alive on its own. Relying on a real wall-clock timer here is flaky: the
	// process can settle before the timer fires, leaving the promise pending
	// (and cancelling sibling subtests). Drive it deterministically with the
	// test runner's mock timers instead.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const registry = createApprovalRegistry();
	const promise = registry.request({ description: "stale", timeoutMs: 30 });
	t.mock.timers.tick(30);
	const decision = await promise;
	assert.equal(decision, "decline");
	assert.equal(registry.get(), undefined);
});

test("request resolves to a custom onTimeout decision", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const registry = createApprovalRegistry();
	const promise = registry.request({ description: "auto-yes", timeoutMs: 50, onTimeout: "accept" });
	t.mock.timers.tick(50);
	assert.equal(await promise, "accept");
	assert.equal(registry.get(), undefined);
});

test("get() lazily expires pending entries that crossed the expiry boundary", async () => {
	let clock = 1_000;
	const registry = createApprovalRegistry(() => clock);
	const promise = registry.request({ description: "lazy", timeoutMs: 100 });
	assert.ok(registry.get());

	clock = 1_500; // way past expiry
	assert.equal(registry.get(), undefined, "expected lazy expiry to clear the entry");
	assert.equal(await promise, "decline");
});

test("custom spokenPrompt is preserved", async () => {
	const registry = createApprovalRegistry();
	registry.request({
		description: "x",
		spokenPrompt: "Run command x. Say yes to allow.",
		timeoutMs: 5000,
	});
	assert.equal(registry.get()?.spokenPrompt, "Run command x. Say yes to allow.");
	registry.accept();
});
