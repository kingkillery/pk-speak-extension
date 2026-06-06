import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	appendRealtimeTerminalAuditEvent,
	buildRealtimeTerminalAuditResult,
	getRealtimeTerminalAuditPath,
	readRealtimeTerminalAuditEvents,
} from "../dist/realtime-terminal-audit.js";

function withIsolatedStore(fn) {
	return () => {
		const previousLocalAppData = process.env.LOCALAPPDATA;
		const previousAppData = process.env.APPDATA;
		const previousLimit = process.env.PI_SPEAK_REALTIME_TERMINAL_AUDIT_TEXT_CHARS;
		const root = mkdtempSync(join(tmpdir(), "pi-speak-terminal-audit-"));
		process.env.LOCALAPPDATA = root;
		process.env.APPDATA = root;
		try {
			fn(root);
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			if (previousAppData === undefined) delete process.env.APPDATA;
			else process.env.APPDATA = previousAppData;
			if (previousLimit === undefined) delete process.env.PI_SPEAK_REALTIME_TERMINAL_AUDIT_TEXT_CHARS;
			else process.env.PI_SPEAK_REALTIME_TERMINAL_AUDIT_TEXT_CHARS = previousLimit;
			rmSync(root, { recursive: true, force: true });
		}
	};
}

test(
	"realtime terminal audit appends JSONL events in the pi-speak store",
	withIsolatedStore((root) => {
		const event = appendRealtimeTerminalAuditEvent({
			ts: 123,
			kind: "terminal.request",
			sessionId: "sess-test",
			provider: "gemini-live",
			toolCallId: "call-1",
			command: "git status --short",
			commandFamily: "git status",
			action: "allow",
			reason: "read-only-allowlist",
			cwd: "C:\\work",
		});

		assert.equal(event.ts, 123);
		const path = getRealtimeTerminalAuditPath();
		assert.equal(path, join(root, "pi-speak-pk", "realtime-terminal-audit.jsonl"));
		assert.ok(existsSync(path));

		const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
		assert.equal(lines.length, 1);
		const parsed = JSON.parse(lines[0]);
		assert.equal(parsed.kind, "terminal.request");
		assert.equal(parsed.command, "git status --short");
		assert.deepEqual(readRealtimeTerminalAuditEvents(), [parsed]);
	}),
);

test(
	"realtime terminal audit result truncates and redacts output previews",
	withIsolatedStore(() => {
		process.env.PI_SPEAK_REALTIME_TERMINAL_AUDIT_TEXT_CHARS = "24";
		const result = buildRealtimeTerminalAuditResult({
			ok: false,
			code: 1,
			stdout: "API_KEY=super-secret-value and more text",
			stderr: "Bearer abcdefghijklmnopqrstuvwxyz",
		});

		assert.equal(result.stdout?.length, "API_KEY=super-secret-value and more text".length);
		assert.equal(result.stdout?.truncated, true);
		assert.match(result.stdout?.text || "", /API_KEY=\[redacted\]/);
		assert.doesNotMatch(result.stdout?.text || "", /super-secret-value/);
		assert.match(result.stderr?.text || "", /Bearer \[redacted\]/);
		assert.doesNotMatch(result.stderr?.text || "", /abcdefghijklmnopqrstuvwxyz/);
	}),
);
