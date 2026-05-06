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
	});
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
