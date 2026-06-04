import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { collectAgentResponse, resolveAgentProviderConfig } from "../dist/agent-provider.js";
import {
	buildAgentResumeArgs,
	buildAgentResumeCommandPreview,
	getAgentProviderCapabilities,
	isResumableAgentSession,
	normalizeAgentProviderName,
	normalizeRunnableAgentProviderName,
} from "../dist/agent-provider-registry.js";
import { CodexAgentProvider } from "../dist/codex-agent-provider.js";
import { PiAgentProvider } from "../dist/pi-agent-provider.js";

test("agent provider config defaults to pi and honors codex overrides", () => {
	assert.deepEqual(resolveAgentProviderConfig({}), {
		provider: "pi",
		codexBin: "codex",
		claudeBin: "claude",
		piBin: "pi",
		model: undefined,
		approvalPolicy: "never",
		sandbox: "danger-full-access",
	});
	assert.deepEqual(resolveAgentProviderConfig({
		AGENT_PROVIDER: "codex",
		CODEX_BIN: "C:/tools/codex.cmd",
		CLAUDE_BIN: "C:/tools/claude.cmd",
		PI_BIN: "C:/tools/pi.cmd",
		AGENT_MODEL: "gpt-test",
	}), {
		provider: "codex",
		codexBin: "C:/tools/codex.cmd",
		claudeBin: "C:/tools/claude.cmd",
		piBin: "C:/tools/pi.cmd",
		model: "gpt-test",
		approvalPolicy: "never",
		sandbox: "danger-full-access",
	});
	assert.equal(resolveAgentProviderConfig({ AGENT_PROVIDER: "gemini" }).provider, "gemini");
	assert.equal(resolveAgentProviderConfig({ AGENT_PROVIDER: "gemini-live" }).provider, "gemini-live");
	assert.equal(resolveAgentProviderConfig({ AGENT_PROVIDER: "elevenlabs" }).provider, "elevenlabs");
	assert.equal(resolveAgentProviderConfig({ AGENT_PROVIDER: "claude" }).provider, "claude");
});

test("agent provider registry normalizes provider names and aliases", () => {
	assert.equal(normalizeAgentProviderName("OpenAI Codex"), "codex");
	assert.equal(normalizeAgentProviderName("claude code"), "claude");
	assert.equal(normalizeAgentProviderName("Gemini Live"), "gemini-live");
	assert.equal(normalizeRunnableAgentProviderName("gemini-live"), undefined);
	assert.equal(normalizeRunnableAgentProviderName("claude code"), "claude");
});

test("agent provider registry exposes capabilities for routing status", () => {
	assert.deepEqual(getAgentProviderCapabilities("codex"), {
		textTurns: true,
		voiceTurns: true,
		audioReplies: true,
		routing: true,
		steering: true,
		resumableSessions: true,
	});
	assert.equal(getAgentProviderCapabilities("claude").resumableSessions, true);
	assert.equal(getAgentProviderCapabilities("pi").resumableSessions, false);
});

test("agent provider registry builds resume commands only for supported sessions", () => {
	assert.equal(isResumableAgentSession("codex", "abc123"), true);
	assert.equal(isResumableAgentSession("claude", "3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad"), true);
	assert.equal(isResumableAgentSession("claude", "not-a-uuid"), false);
	assert.deepEqual(buildAgentResumeArgs("codex", "abc123", "C:\\dev\\project"), ["resume", "-C", "C:\\dev\\project", "abc123"]);
	assert.deepEqual(buildAgentResumeArgs("claude", "3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad", "C:\\dev\\project"), [
		"--resume",
		"3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad",
	]);
	assert.deepEqual(buildAgentResumeCommandPreview("codex", "abc123", "codex.cmd", "C:\\dev\\project"), [
		"codex.cmd",
		"resume",
		"-C",
		"C:\\dev\\project",
		"abc123",
	]);
	assert.equal(buildAgentResumeCommandPreview("pi", "abc123", "pi.cmd"), undefined);
});

test("pi provider streams message updates and completes on agent end", async () => {
	const sent = [];
	const provider = new PiAgentProvider({
		sendUserMessage: (content, options) => sent.push({ content, options }),
	});

	const response = collectAgentResponse(provider, "hello");
	await new Promise((resolve) => setImmediate(resolve));
	provider.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
	provider.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "lo" } });
	provider.handleAgentEnd();

	assert.equal(await response, "Hello");
	assert.deepEqual(sent, [{ content: "hello", options: undefined }]);
});

test("pi provider emits final assistant text when streaming deltas are unavailable", async () => {
	const provider = new PiAgentProvider({
		sendUserMessage: () => {},
	});

	const response = collectAgentResponse(provider, "hello");
	await new Promise((resolve) => setImmediate(resolve));
	provider.handleMessageEnd("Final answer");
	provider.handleAgentEnd();

	assert.equal(await response, "Final answer");
});

test("codex provider tears down failed app-server before exec fallback", async () => {
	const children = [];
	const spawnImpl = (_command, args) => {
		const child = createFakeChild();
		children.push({ args: [...args], child });
		if (args[0] === "app-server") {
			child.onStdinJson = (message) => {
				child.stdout.write(`${JSON.stringify({
					id: message.id,
					error: { code: -32000, message: "initialize failed" },
				})}\n`);
			};
			return child;
		}
		if (args[0] === "exec") {
			setImmediate(() => {
				child.stdout.write(`${JSON.stringify({
					method: "item/agentMessage/delta",
					params: { delta: "fallback reply" },
				})}\n`);
				child.emit("exit", 0);
			});
			return child;
		}
		throw new Error(`Unexpected spawn args: ${args.join(" ")}`);
	};
	const provider = new CodexAgentProvider({
		codexBin: "codex-test",
		cwd: "C:/repo",
		spawnImpl,
	});

	assert.equal(await collectAgentResponse(provider, "hello"), "fallback reply");
	assert.deepEqual(children.map((entry) => entry.args[0]), ["app-server", "exec"]);
	assert.equal(children[0].child.killed, true);
});

test("codex provider routes server-initiated approval requests to onApprovalRequest", async () => {
	const sentToCodex = [];
	let appServerChild;
	const spawnImpl = (_command, args) => {
		const child = createFakeChild();
		if (args[0] === "app-server") {
			appServerChild = child;
			child.onStdinJson = (message) => {
				sentToCodex.push(message);
				if (message.method === "initialize") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: { protocolVersion: "test" } })}\n`);
					return;
				}
				if (message.method === "thread/start") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thr_test" } } })}\n`);
					return;
				}
				if (message.method === "turn/start") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_test" } } })}\n`);
					// Server-initiated approval request after turn starts.
					setImmediate(() => {
						child.stdout.write(`${JSON.stringify({
							id: 999,
							method: "item/commandExecution/requestApproval",
							params: { command: "rm -rf dist/", cwd: "/repo", reason: "cleanup" },
						})}\n`);
					});
					return;
				}
				// Approval response written by provider — capture and complete the turn.
				if (message.id === 999) {
					setImmediate(() => {
						child.stdout.write(`${JSON.stringify({
							method: "turn/completed",
							params: { threadId: "thr_test", turn: { id: "turn_test", status: "completed" } },
						})}\n`);
					});
				}
			};
			return child;
		}
		throw new Error(`Unexpected spawn args: ${args.join(" ")}`);
	};

	const approvalCalls = [];
	const provider = new CodexAgentProvider({
		codexBin: "codex-test",
		cwd: "/repo",
		spawnImpl,
		onApprovalRequest: async (request) => {
			approvalCalls.push(request);
			return "accept";
		},
	});

	await collectAgentResponse(provider, "do the thing");

	assert.equal(approvalCalls.length, 1);
	assert.equal(approvalCalls[0].method, "item/commandExecution/requestApproval");
	assert.equal(approvalCalls[0].params.command, "rm -rf dist/");

	const approvalResponse = sentToCodex.find((message) => message.id === 999);
	assert.ok(approvalResponse, "expected approval response written back to codex");
	assert.deepEqual(approvalResponse.result, { decision: "accept" });
});

test("codex provider auto-declines approval requests when no handler is configured", async () => {
	const sentToCodex = [];
	const spawnImpl = (_command, args) => {
		const child = createFakeChild();
		if (args[0] === "app-server") {
			child.onStdinJson = (message) => {
				sentToCodex.push(message);
				if (message.method === "initialize") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
					return;
				}
				if (message.method === "thread/start") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thr_test" } } })}\n`);
					return;
				}
				if (message.method === "turn/start") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_test" } } })}\n`);
					setImmediate(() => {
						child.stdout.write(`${JSON.stringify({
							id: 42,
							method: "item/fileChange/requestApproval",
							params: { reason: "edit foo.ts" },
						})}\n`);
					});
					return;
				}
				if (message.id === 42) {
					setImmediate(() => {
						child.stdout.write(`${JSON.stringify({
							method: "turn/completed",
							params: { threadId: "thr_test", turn: { id: "turn_test", status: "completed" } },
						})}\n`);
					});
				}
			};
			return child;
		}
		throw new Error(`Unexpected spawn args: ${args.join(" ")}`);
	};

	const provider = new CodexAgentProvider({ codexBin: "codex-test", cwd: "/repo", spawnImpl });
	await collectAgentResponse(provider, "edit foo");

	const response = sentToCodex.find((message) => message.id === 42);
	assert.ok(response, "expected auto-decline response");
	assert.deepEqual(response.result, { decision: "decline" });
});

test("codex provider echoes scope+permissions on permissions accept", async () => {
	const sentToCodex = [];
	const spawnImpl = (_command, args) => {
		const child = createFakeChild();
		if (args[0] === "app-server") {
			child.onStdinJson = (message) => {
				sentToCodex.push(message);
				if (message.method === "initialize") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
					return;
				}
				if (message.method === "thread/start") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "t" } } })}\n`);
					return;
				}
				if (message.method === "turn/start") {
					child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "tu" } } })}\n`);
					setImmediate(() => {
						child.stdout.write(`${JSON.stringify({
							id: 7,
							method: "item/permissions/requestApproval",
							params: { reason: "workspace root", permissions: { fileSystem: { write: ["/repo"] } } },
						})}\n`);
					});
					return;
				}
				if (message.id === 7) {
					setImmediate(() => {
						child.stdout.write(`${JSON.stringify({
							method: "turn/completed",
							params: { threadId: "t", turn: { id: "tu", status: "completed" } },
						})}\n`);
					});
				}
			};
			return child;
		}
		throw new Error(`Unexpected spawn args: ${args.join(" ")}`);
	};

	const provider = new CodexAgentProvider({
		codexBin: "codex-test",
		cwd: "/repo",
		spawnImpl,
		onApprovalRequest: async () => "accept",
	});

	await collectAgentResponse(provider, "grant root");
	const response = sentToCodex.find((message) => message.id === 7);
	assert.ok(response);
	assert.deepEqual(response.result, { scope: "session", permissions: { fileSystem: { write: ["/repo"] } } });
});

function createFakeChild() {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		child.emit("exit", null);
		return true;
	};
	child.stdin = new PassThrough();
	child.stdin.write = (chunk, callback) => {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		for (const line of text.split(/\r?\n/).filter(Boolean)) {
			child.onStdinJson?.(JSON.parse(line));
		}
		if (typeof callback === "function") callback();
		return true;
	};
	child.stdin.end = () => {};
	return child;
}
