import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SPEECH_HINT,
	SPEECH_LINE_CAP,
	SPEECH_LIST_CAP,
	SPEECH_PASS_THROUGH_MAX,
	SPEECH_TEXT_CAP,
	clipSpeechText,
	shapeRealtimeToolOutputForSpeech,
} from "../dist/realtime-speech-brief.js";

test("clipSpeechText leaves short text alone", () => {
	const result = clipSpeechText("hello");
	assert.equal(result.text, "hello");
	assert.equal(result.truncated, false);
	assert.equal(result.originalLength, 5);
});

test("clipSpeechText truncates long text with marker", () => {
	const long = "a".repeat(SPEECH_TEXT_CAP + 200);
	const result = clipSpeechText(long);
	assert.equal(result.truncated, true);
	assert.equal(result.originalLength, long.length);
	assert.ok(result.text.includes("truncated for speech"));
	assert.ok(result.text.length < long.length);
});

test("short plain acknowledgements pass through unchanged", () => {
	assert.equal(shapeRealtimeToolOutputForSpeech("launch_agent", "ok"), "ok");
	assert.equal(shapeRealtimeToolOutputForSpeech("launch_agent", "done"), "done");
	assert.equal(
		shapeRealtimeToolOutputForSpeech("execute_terminal_command", "planning the work"),
		"planning the work",
	);
});

test("long plain text becomes a speech brief with speechHint", () => {
	const long = "line\n".repeat(SPEECH_LINE_CAP + 20);
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("unknown_tool", long));
	assert.equal(shaped.ok, true);
	assert.equal(shaped.speechHint, DEFAULT_SPEECH_HINT);
	assert.equal(shaped.truncated, true);
	assert.ok(shaped.summary.includes("more lines omitted") || shaped.summary.includes("truncated for speech"));
	assert.ok(shaped.summary.length < long.length);
});

test("execute_terminal_command shapes stdout/stderr and adds summary", () => {
	const stdout = Array.from({ length: 80 }, (_, i) => `out line ${i}`).join("\n");
	const stderr = Array.from({ length: 5 }, (_, i) => `err ${i}`).join("\n");
	const raw = JSON.stringify({
		ok: false,
		code: 1,
		command: "npm test",
		stdout,
		stderr,
	});
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("execute_terminal_command", raw));
	assert.equal(shaped.ok, false);
	assert.equal(shaped.code, 1);
	assert.equal(shaped.command, "npm test");
	assert.equal(shaped.speechHint, DEFAULT_SPEECH_HINT);
	assert.match(shaped.summary, /Command failed/);
	assert.match(shaped.summary, /exit 1/);
	assert.equal(shaped.stdoutTruncated, true);
	assert.ok(shaped.stdout.length < stdout.length);
	assert.ok(shaped.stdoutOriginalLength === stdout.length);
	// stderr is short enough on lines but still present
	assert.ok(typeof shaped.stderr === "string");
});

test("read_workspace_file truncates long content and never drops the summary", () => {
	const content = Array.from({ length: 200 }, (_, i) => `export const x${i} = ${i};`).join("\n");
	const raw = JSON.stringify({
		ok: true,
		file: {
			name: "big.ts",
			path: "src/big.ts",
			size: content.length,
			binary: false,
			content,
		},
	});
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("read_workspace_file", raw));
	assert.equal(shaped.ok, true);
	assert.equal(shaped.file.name, "big.ts");
	assert.equal(shaped.file.contentTruncatedForSpeech, true);
	assert.ok(shaped.file.content.length < content.length);
	assert.ok(!shaped.file.content.includes("export const x199"));
	assert.match(shaped.summary, /big\.ts/);
	assert.match(shaped.summary, /preview only/);
	assert.equal(shaped.speechHint, DEFAULT_SPEECH_HINT);
});

test("read_workspace_file keeps short content intact", () => {
	const raw = JSON.stringify({
		ok: true,
		file: {
			name: "notes.txt",
			path: "notes.txt",
			size: 15,
			binary: false,
			content: "hello from disk",
		},
	});
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("read_workspace_file", raw));
	assert.equal(shaped.file.content, "hello from disk");
	assert.equal(shaped.file.contentTruncatedForSpeech, undefined);
	assert.match(shaped.summary, /notes\.txt/);
});

test("list payloads cap large arrays and preserve totals", () => {
	const agents = Array.from({ length: SPEECH_LIST_CAP + 10 }, (_, i) => ({
		id: `a${i}`,
		name: `agent-${i}`,
		status: "running",
	}));
	const raw = JSON.stringify({ ok: true, folders: [{ key: "root" }], agents });
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("list_agent_hub_agents", raw));
	assert.equal(shaped.ok, true);
	assert.equal(shaped.agents.length, SPEECH_LIST_CAP);
	assert.equal(shaped.agentsTruncatedForSpeech, true);
	assert.equal(shaped.agentTotal, agents.length);
	assert.equal(shaped.speechHint, DEFAULT_SPEECH_HINT);
});

test("get_agent_hub_agent clips long transcript tails", () => {
	const transcript = Array.from({ length: 120 }, (_, i) => `step ${i}: did a thing with lots of detail`).join("\n");
	const raw = JSON.stringify({
		ok: true,
		agent: { id: "a1", name: "fixer", status: "running", transcript },
	});
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("get_agent_hub_agent", raw));
	assert.equal(shaped.agent.transcriptTruncatedForSpeech, true);
	assert.ok(shaped.agent.transcript.length < transcript.length);
	assert.match(shaped.summary, /fixer/);
	assert.match(shaped.summary, /running/);
});

test("error objects stay truthful and get a speechHint", () => {
	const raw = JSON.stringify({
		ok: false,
		error: "Refusing to read a file that looks like it may hold secrets or credentials.",
	});
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("read_workspace_file", raw));
	assert.equal(shaped.ok, false);
	assert.match(shaped.error, /secrets or credentials/);
	assert.equal(shaped.speechHint, DEFAULT_SPEECH_HINT);
});

test("invalid JSON falls back to clipped plain-text brief", () => {
	const garbage = "{not-json " + "x".repeat(SPEECH_PASS_THROUGH_MAX);
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("execute_terminal_command", garbage));
	assert.equal(shaped.ok, true);
	assert.equal(shaped.parseError, true);
	assert.equal(shaped.speechHint, DEFAULT_SPEECH_HINT);
});

test("mutation acknowledgements keep ok/message fields", () => {
	const raw = JSON.stringify({ ok: true, message: "launched", sessionPath: "/tmp/repo/new-session.jsonl" });
	const shaped = JSON.parse(shapeRealtimeToolOutputForSpeech("launch_agent", raw));
	assert.equal(shaped.ok, true);
	assert.equal(shaped.message, "launched");
	assert.equal(shaped.sessionPath, "/tmp/repo/new-session.jsonl");
	assert.equal(shaped.speechHint, DEFAULT_SPEECH_HINT);
});
