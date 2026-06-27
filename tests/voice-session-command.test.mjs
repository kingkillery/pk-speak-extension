import test from "node:test";
import assert from "node:assert/strict";
import {
	parseVoiceBridgePrompt,
	parseVoiceSlashCommand,
	shouldBlockCrossSessionVoiceRoute,
} from "../dist/voice-session-command.js";

test("voice parser maps session management phrases to slash commands", () => {
	assert.deepEqual(parseVoiceSlashCommand("new session bugfix"), {
		kind: "slash-command",
		command: "/sess new bugfix",
	});
	assert.deepEqual(parseVoiceSlashCommand("switch to session to Google"), {
		kind: "slash-command",
		command: "/sess switch to google",
	});
	assert.deepEqual(parseVoiceSlashCommand("name this session active work"), {
		kind: "slash-command",
		command: "/sess name active work",
	});
	assert.deepEqual(parseVoiceSlashCommand("list sessions"), {
		kind: "slash-command",
		command: "/sess",
	});
	assert.deepEqual(parseVoiceSlashCommand("current session"), {
		kind: "slash-command",
		command: "/sess",
	});
	assert.deepEqual(parseVoiceSlashCommand("remove session bugfix"), {
		kind: "slash-command",
		command: "/sess remove bugfix",
	});
});

test("voice parser maps archive/recover/launch/workspace phrases to slash commands", () => {
	assert.deepEqual(parseVoiceSlashCommand("archive session bugfix"), {
		kind: "slash-command",
		command: "/sess archive bugfix",
	});
	assert.deepEqual(parseVoiceSlashCommand("recover session bugfix"), {
		kind: "slash-command",
		command: "/sess recover bugfix",
	});
	assert.deepEqual(parseVoiceSlashCommand("unarchive session bugfix"), {
		kind: "slash-command",
		command: "/sess recover bugfix",
	});
	assert.deepEqual(parseVoiceSlashCommand("launch agent reviewer"), {
		kind: "slash-command",
		command: "/sess launch reviewer",
	});
	assert.deepEqual(parseVoiceSlashCommand("launch agent hub"), {
		kind: "slash-command",
		command: "/sess launch hub",
	});
	assert.deepEqual(parseVoiceSlashCommand("list workspaces"), {
		kind: "slash-command",
		command: "/sess workspaces",
	});
});

test("voice parser maps wake alias phrases to slash commands", () => {
	assert.deepEqual(parseVoiceSlashCommand("set wake alias one"), {
		kind: "slash-command",
		command: "/sess wake one",
	});
	assert.deepEqual(parseVoiceSlashCommand("clear wake alias one"), {
		kind: "slash-command",
		command: "/sess wake clear one",
	});
	assert.deepEqual(parseVoiceSlashCommand("show wake aliases"), {
		kind: "slash-command",
		command: "/sess",
	});
	assert.deepEqual(parseVoiceSlashCommand("export sessions"), {
		kind: "slash-command",
		command: "/sess export",
	});
});

test("voice parser routes ready-state questions through the session manager", () => {
	assert.deepEqual(parseVoiceSlashCommand("what's ready"), {
		kind: "slash-command",
		command: "/sess",
	});
	assert.deepEqual(parseVoiceSlashCommand("attention status"), {
		kind: "slash-command",
		command: "/attn status",
	});
	assert.deepEqual(parseVoiceSlashCommand("clear attention for bugfix"), {
		kind: "slash-command",
		command: "/attn clear bugfix",
	});
});

test("voice parser maps skill bridge phrases into explicit prompts", () => {
	assert.deepEqual(parseVoiceBridgePrompt("use the prompt optimizer skill for make this system prompt shorter"), {
		kind: "bridge-prompt",
		prompt: "Use the installed skill \"prompt optimizer\" if it exists and is relevant. Follow that skill's instructions before acting.\n\nUser request: make this system prompt shorter",
	});
	assert.deepEqual(parseVoiceBridgePrompt("pick the right skill for compare these candidate patches"), {
		kind: "bridge-prompt",
		prompt: "Find and use the best matching installed skill for this request. Follow that skill before acting.\n\nIf the request is about improving a prompt, instructions, skills, or workflow behavior, use the most relevant improvement workflow as needed.\n\nUser request: compare these candidate patches",
	});
	assert.deepEqual(parseVoiceBridgePrompt("bridge to llm as verifier skill"), {
		kind: "bridge-prompt",
		prompt: "Use the installed skill \"llm as verifier\" if it exists and is relevant. Follow that skill's instructions before acting.",
	});
});

test("voice parser leaves ordinary speech alone", () => {
	assert.equal(parseVoiceSlashCommand("explain the test failures"), undefined);
	assert.equal(parseVoiceBridgePrompt("explain the test failures"), undefined);
});

test("cross-session routing is blocked while current session is busy", () => {
	assert.equal(shouldBlockCrossSessionVoiceRoute({
		currentSessionPath: "/sessions/current.jsonl",
		targetSessionPath: "/sessions/other.jsonl",
		idle: false,
	}), true);
	assert.equal(shouldBlockCrossSessionVoiceRoute({
		currentSessionPath: "/sessions/current.jsonl",
		targetSessionPath: "/sessions/current.jsonl",
		idle: false,
	}), false);
	assert.equal(shouldBlockCrossSessionVoiceRoute({
		currentSessionPath: "/sessions/current.jsonl",
		targetSessionPath: "/sessions/other.jsonl",
		idle: true,
	}), false);
});
