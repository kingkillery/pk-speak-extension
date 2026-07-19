import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeCommandApprovalRegistry } from "../dist/realtime-command-approval.js";

test("realtime command approval registry creates and resolves pending mutations", () => {
	let clock = 1_000;
	const registry = createRealtimeCommandApprovalRegistry(() => clock, { timeoutMs: 500 });
	const approval = registry.request("launch_agent", "Launch a new background agent in /repo.");

	assert.equal(approval.kind, "launch_agent");
	assert.equal(approval.description, "Launch a new background agent in /repo.");
	assert.equal(approval.status, "pending");
	assert.equal(registry.get(approval.id)?.description, "Launch a new background agent in /repo.");

	const resolved = registry.resolve(approval.id, true);
	assert.equal(resolved?.status, "approved");
	assert.equal(registry.get(approval.id), undefined);
});

test("realtime command approval registry rejects on resolve(false)", () => {
	const registry = createRealtimeCommandApprovalRegistry(() => 1_000, { timeoutMs: 500 });
	const approval = registry.request("archive_session", "Archive session /repo/session.jsonl.");

	const resolved = registry.resolve(approval.id, false);
	assert.equal(resolved?.status, "rejected");
	assert.equal(registry.get(approval.id), undefined);
});

test("realtime command approval registry expires stale mutations", () => {
	let clock = 1_000;
	const registry = createRealtimeCommandApprovalRegistry(() => clock, { timeoutMs: 500 });
	const approval = registry.request("launch_agent", "Launch a new background agent.");

	clock = 2_000;
	assert.equal(registry.get(approval.id), undefined);
	assert.equal(registry.list().length, 0);
});

test("realtime command approval registry explicit expire returns the mutation for timeout response", () => {
	const registry = createRealtimeCommandApprovalRegistry(() => 1_000, { timeoutMs: 500 });
	const approval = registry.request("archive_session", "Recover session /repo/session.jsonl.");

	const expired = registry.expire(approval.id);
	assert.equal(expired?.status, "expired");
	assert.equal(expired?.kind, "archive_session");
	assert.equal(registry.get(approval.id), undefined);
});

test("realtime command approval registry keeps separate pending mutations independent", () => {
	const registry = createRealtimeCommandApprovalRegistry(() => 1_000, { timeoutMs: 500 });
	const first = registry.request("launch_agent", "Launch agent A.");
	const second = registry.request("archive_session", "Archive session B.");

	registry.resolve(first.id, true);
	assert.equal(registry.get(first.id), undefined);
	assert.equal(registry.get(second.id)?.status, "pending");
});
