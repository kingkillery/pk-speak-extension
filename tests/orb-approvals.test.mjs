import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const helpersPath = resolve(here, "../web/remote/orb-approvals.js");
const { approvalControlType, normalizeApproval } = await import(pathToFileURL(helpersPath).href);

test("normalizeApproval requires approvalId", () => {
	assert.equal(normalizeApproval({}), null);
	assert.equal(normalizeApproval({ approvalId: "" }), null);
	const a = normalizeApproval({
		approvalId: "appr_1",
		name: "execute_terminal_command",
		command: "git status",
		reason: "requires_confirmation",
		cwd: "C:\\repo",
		timeoutMs: 5000,
	});
	assert.ok(a);
	assert.equal(a.approvalId, "appr_1");
	assert.equal(a.command, "git status");
	assert.equal(a.cwd, "C:\\repo");
});

test("normalizeApproval parses output JSON fallbacks", () => {
	const a = normalizeApproval({
		approvalId: "x",
		output: JSON.stringify({ command: "ls", reason: "confirm", cwd: "/tmp" }),
	});
	assert.ok(a);
	assert.equal(a.command, "ls");
	assert.equal(a.reason, "confirm");
	assert.equal(a.cwd, "/tmp");
});

test("approvalControlType maps terminal vs command tools", () => {
	assert.equal(
		approvalControlType({ name: "execute_terminal_command", reason: "requires_confirmation" }, true),
		"terminal_approve",
	);
	assert.equal(
		approvalControlType({ name: "execute_terminal_command" }, false),
		"terminal_reject",
	);
	assert.equal(
		approvalControlType({ name: "launch_agent", reason: "launch_agent" }, true),
		"command_approve",
	);
	assert.equal(
		approvalControlType({ name: "archive_session", reason: "archive_session" }, false),
		"command_reject",
	);
});
