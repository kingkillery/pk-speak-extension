import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeTerminalApprovalRegistry } from "../dist/realtime-terminal-approval.js";

test("realtime terminal approval registry creates and resolves pending commands", () => {
	let clock = 1_000;
	const registry = createRealtimeTerminalApprovalRegistry(() => clock, { timeoutMs: 500 });
	const approval = registry.request("npm install", "mutating-command");

	assert.equal(approval.command, "npm install");
	assert.equal(approval.reason, "mutating-command");
	assert.equal(approval.status, "pending");
	assert.equal(registry.get(approval.id)?.command, "npm install");

	const resolved = registry.resolve(approval.id, true);
	assert.equal(resolved?.status, "approved");
	assert.equal(registry.get(approval.id), undefined);
});

test("realtime terminal approval registry expires stale commands", () => {
	let clock = 1_000;
	const registry = createRealtimeTerminalApprovalRegistry(() => clock, { timeoutMs: 500 });
	const approval = registry.request("git commit -m test", "mutating-command");

	clock = 2_000;
	assert.equal(registry.get(approval.id), undefined);
	assert.equal(registry.list().length, 0);
});

test("realtime terminal approval registry explicit expire returns the command for timeout response", () => {
	const registry = createRealtimeTerminalApprovalRegistry(() => 1_000, { timeoutMs: 500 });
	const approval = registry.request("rg TODO > todo.txt", "shell-control-operator");

	const expired = registry.expire(approval.id);
	assert.equal(expired?.status, "expired");
	assert.equal(expired?.command, "rg TODO > todo.txt");
	assert.equal(registry.get(approval.id), undefined);
});
