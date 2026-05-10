import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { collectAgentResponse, resolveAgentProviderConfig } from "../dist/agent-provider.js";
import { CodexAgentProvider } from "../dist/codex-agent-provider.js";
import { PiAgentProvider } from "../dist/pi-agent-provider.js";

test("agent provider config defaults to pi and honors codex overrides", () => {
	assert.deepEqual(resolveAgentProviderConfig({}), {
		provider: "pi",
		codexBin: "codex",
		piBin: "pi",
		model: undefined,
		approvalPolicy: "never",
		sandbox: "danger-full-access",
	});
	assert.deepEqual(resolveAgentProviderConfig({
		AGENT_PROVIDER: "codex",
		CODEX_BIN: "C:/tools/codex.cmd",
		PI_BIN: "C:/tools/pi.cmd",
		AGENT_MODEL: "gpt-test",
	}), {
		provider: "codex",
		codexBin: "C:/tools/codex.cmd",
		piBin: "C:/tools/pi.cmd",
		model: "gpt-test",
		approvalPolicy: "never",
		sandbox: "danger-full-access",
	});
	assert.equal(resolveAgentProviderConfig({ AGENT_PROVIDER: "gemini" }).provider, "gemini");
	assert.equal(resolveAgentProviderConfig({ AGENT_PROVIDER: "gemini-live" }).provider, "gemini-live");
	assert.equal(resolveAgentProviderConfig({ AGENT_PROVIDER: "elevenlabs" }).provider, "elevenlabs");
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
