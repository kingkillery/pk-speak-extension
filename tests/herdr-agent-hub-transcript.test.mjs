import test from "node:test";
import assert from "node:assert/strict";
import {
	distillToolCallSummary,
	filterDigestTurns,
	parseSessionTranscript,
} from "../dist/herdr-agent-hub-transcript.js";

function jsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

let messageCounter = 0;

function messageRecord(role, content, extra = {}) {
	messageCounter += 1;
	return jsonLine({
		type: "message",
		id: extra.id ?? `m-${messageCounter}`,
		timestamp: extra.timestamp ?? "2026-07-29T10:00:00.000Z",
		message: { role, content, ...extra.message },
	});
}

test("parseSessionTranscript extracts the session header and latest model", () => {
	const jsonl =
		jsonLine({ type: "session", version: 3, id: "s-1", cwd: "/repo", title: "Fix the bug", timestamp: "2026-07-29T09:00:00.000Z" })
		+ jsonLine({ type: "model_change", model: "gpt-5", timestamp: "2026-07-29T09:01:00.000Z" })
		+ jsonLine({ type: "model_change", model: "k3", timestamp: "2026-07-29T09:02:00.000Z" })
		+ messageRecord("user", [{ type: "text", text: "hello" }]);
	const digest = parseSessionTranscript(jsonl);
	assert.equal(digest.sessionId, "s-1");
	assert.equal(digest.title, "Fix the bug");
	assert.equal(digest.cwd, "/repo");
	assert.equal(digest.model, "k3");
	assert.equal(digest.stats.messages, 1);
	assert.equal(digest.truncated, false);
});

test("thinking content is flagged but never included", () => {
	const jsonl = messageRecord("assistant", [
		{ type: "thinking", thinking: "secret internal reasoning that must not leak" },
		{ type: "text", text: "visible answer" },
	]);
	const digest = parseSessionTranscript(jsonl);
	assert.equal(digest.turns.length, 1);
	assert.equal(digest.turns[0].hasThinking, true);
	assert.equal(digest.turns[0].text, "visible answer");
	assert.ok(!JSON.stringify(digest).includes("secret internal reasoning"));
});

test("tool calls are distilled, counted, and paths collected", () => {
	const jsonl = messageRecord("assistant", [
		{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/repo/src/index.ts" } },
		{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "npm test" } },
	]);
	const digest = parseSessionTranscript(jsonl);
	assert.equal(digest.stats.toolCalls, 2);
	assert.deepEqual(digest.turns[0].toolCalls, [
		{ name: "read", summary: "/repo/src/index.ts" },
		{ name: "bash", summary: "npm test" },
	]);
	assert.deepEqual(digest.stats.filesTouched, ["/repo/src/index.ts"]);
});

test("secret-shaped tool arguments are redacted from summaries and files", () => {
	const jsonl = messageRecord("assistant", [
		{ type: "toolCall", id: "t1", name: "deploy", arguments: { apiKey: "sk-live-secret", path: "/repo/out", region: "us" } },
	]);
	const digest = parseSessionTranscript(jsonl);
	const summary = digest.turns[0].toolCalls[0].summary;
	assert.ok(!summary.includes("sk-live-secret"), "raw key must not appear in the summary");
	assert.ok(summary.includes("[redacted]"));
	assert.deepEqual(digest.stats.filesTouched, ["/repo/out"]);
});

test("toolResult errors are counted and keep their tool name", () => {
	const jsonl =
		messageRecord("toolResult", [{ type: "text", text: "exit 1" }], { message: { toolName: "bash", isError: true } })
		+ messageRecord("toolResult", [{ type: "text", text: "ok" }], { message: { toolName: "read", isError: false } });
	const digest = parseSessionTranscript(jsonl);
	assert.equal(digest.stats.toolErrors, 1);
	assert.equal(digest.turns[0].toolName, "bash");
	assert.equal(digest.turns[0].isError, true);
	assert.equal(digest.turns[1].isError, false);
});

test("maxTurns keeps the LAST turns and marks the digest truncated", () => {
	const jsonl = Array.from({ length: 10 }, (_, i) =>
		messageRecord("user", [{ type: "text", text: `turn-${i}` }])).join("");
	const digest = parseSessionTranscript(jsonl, { maxTurns: 3 });
	assert.equal(digest.turns.length, 3);
	assert.deepEqual(digest.turns.map((t) => t.text), ["turn-7", "turn-8", "turn-9"]);
	assert.equal(digest.truncated, true);
	// Stats still describe the whole transcript, not just the kept turns.
	assert.equal(digest.stats.messages, 10);
});

test("malformed and non-json lines are skipped without throwing", () => {
	const jsonl =
		"not json at all\n"
		+ "{broken json\n"
		+ jsonLine({ type: "message", timestamp: "2026-07-29T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "kept" }] } });
	const digest = parseSessionTranscript(jsonl);
	assert.equal(digest.stats.messages, 1);
	assert.equal(digest.turns[0].text, "kept");
});

test("a mid-file tail without the session header still parses", () => {
	const digest = parseSessionTranscript(
		messageRecord("assistant", [{ type: "text", text: "tail only" }]),
	);
	assert.equal(digest.sessionId, undefined);
	assert.equal(digest.cwd, undefined);
	assert.equal(digest.turns[0].text, "tail only");
});

test("per-turn text is capped", () => {
	const long = "x".repeat(1000);
	const digest = parseSessionTranscript(
		messageRecord("assistant", [{ type: "text", text: long }]),
		{ maxTextChars: 100 },
	);
	assert.equal(digest.turns[0].text.length, 101); // 100 chars + ellipsis
	assert.ok(digest.turns[0].text.endsWith("…"));
});

test("filesTouched skips URI and docid values found in real transcripts", () => {
	const jsonl = messageRecord("assistant", [
		{ type: "toolCall", id: "t1", name: "read", arguments: { path: "skill://?q=ingest daemon" } },
		{ type: "toolCall", id: "t2", name: "mcp__pk_qmd_get", arguments: { file: "#662eda" } },
		{ type: "toolCall", id: "t3", name: "task", arguments: { projectPath: "C:/dev/repo", workdir: "C:/dev/repo/sub" } },
		{ type: "toolCall", id: "t4", name: "read", arguments: { path: "/real/file.ts" } },
	]);
	const digest = parseSessionTranscript(jsonl);
	assert.deepEqual(digest.stats.filesTouched, ["C:/dev/repo", "C:/dev/repo/sub", "/real/file.ts"]);
});

test("credential VALUES are scrubbed from summaries even without secret-shaped keys", () => {
	const jsonl = messageRecord("assistant", [
		{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "curl -H 'Authorization: Bearer sk-live-abcdef123456' https://api.example.com" } },
		{ type: "toolCall", id: "t2", name: "eval", arguments: { language: "py", code: "token = 'sk-abcdefghijklmnop'\nprint(token)" } },
		{ type: "toolCall", id: "t3", name: "mcp__svc_call", arguments: { endpoint: "/v1/x", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9" } } },
	]);
	const digest = parseSessionTranscript(jsonl);
	const serialized = JSON.stringify(digest);
	assert.ok(!serialized.includes("sk-live-abcdef123456"), "bearer token in bash command must not leak");
	assert.ok(!serialized.includes("sk-abcdefghijklmnop"), "token literal in eval code must not leak");
	assert.ok(!serialized.includes("eyJhbGciOiJIUzI1NiJ9"), "nested headers.Authorization must be redacted by key");
	assert.ok(serialized.includes("[redacted]"), "redaction markers replace the values");
});

test("credential values are scrubbed from toolResult and message text", () => {
	const jsonl =
		messageRecord("toolResult", [{ type: "text", text: "OPENAI_API_KEY=sk-proj-abcdef123456\nmode=fast" }], { message: { toolName: "read", isError: false } })
		+ messageRecord("assistant", [{ type: "text", text: "Found -----BEGIN OPENSSH PRIVATE KEY----- in the file" }]);
	const digest = parseSessionTranscript(jsonl);
	const serialized = JSON.stringify(digest);
	assert.ok(!serialized.includes("sk-proj-abcdef123456"), ".env-style assignment must not leak through toolResult text");
	assert.ok(!serialized.includes("OPENSSH PRIVATE KEY"), "PEM header must not leak through assistant text");
	assert.ok(serialized.includes("mode=fast"), "non-secret content survives the scrub");
});

test("distillToolCallSummary renders eval calls compactly", () => {
	assert.equal(
		distillToolCallSummary("eval", { language: "py", title: "load config", code: "print(1)" }),
		"py: load config",
	);
	assert.equal(distillToolCallSummary("read", { path: "/a/b.ts" }), "/a/b.ts");
	assert.equal(distillToolCallSummary("mystery", undefined), "");
});

test("filterDigestTurns matches text, tool names, and summaries case-insensitively", () => {
	const jsonl =
		messageRecord("user", [{ type: "text", text: "Please fix the Login page" }])
		+ messageRecord("assistant", [
			{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "/repo/login.ts" } },
		])
		+ messageRecord("user", [{ type: "text", text: "unrelated chatter" }]);
	const digest = parseSessionTranscript(jsonl);

	const filtered = filterDigestTurns(digest, "login");
	assert.equal(filtered.turns.length, 2);
	assert.deepEqual(filtered.turnFilter, { query: "login", matched: 2 });
	// Stats keep describing the unfiltered digest.
	assert.equal(filtered.stats.messages, 3);

	assert.equal(filterDigestTurns(digest, "  "), digest, "blank query returns the digest unchanged");
	assert.equal(filterDigestTurns(digest, "zzz-no-match").turns.length, 0);
});
