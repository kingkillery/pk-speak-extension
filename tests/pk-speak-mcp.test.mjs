import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { MAX_MCP_SPEAK_TEXT_CHARS, runPkSpeak } = await import("../dist/pk-speak-mcp.js");

function makeChild() {
	const child = new EventEmitter();
	child.stderr = new EventEmitter();
	child.killed = false;
	child.exitCode = null;
	child.signalCode = null;
	child.kill = () => {
		child.killed = true;
		return true;
	};
	return child;
}

test("MCP speech cancels the bundled CLI subprocess", async () => {
	const controller = new AbortController();
	const child = makeChild();
	let spawned;
	const pending = runPkSpeak("A concise spoken update.", {
		signal: controller.signal,
		entrypoint: "/pkg/dist/pk-speak.js",
		spawnCommand(command, args) {
			spawned = { command, args };
			return child;
		},
	});

	controller.abort();
	await assert.rejects(pending, /cancelled/i);
	assert.equal(child.killed, true);
	assert.deepEqual(spawned.args.slice(0, 5), ["/pkg/dist/pk-speak.js", "speak", "--quiet", "--gate", "immediate"]);
});

test("MCP speech timeout terminates the bundled CLI subprocess", async () => {
	const child = makeChild();
	const pending = runPkSpeak("A concise spoken update.", {
		timeoutMs: 1,
		spawnCommand: () => child,
	});
	await assert.rejects(pending, /timed out/i);
	assert.equal(child.killed, true);
});

test("MCP speech rejects oversized input before spawning", () => {
	assert.throws(
		() => runPkSpeak("x".repeat(MAX_MCP_SPEAK_TEXT_CHARS + 1), { spawnCommand: () => makeChild() }),
		/character limit/i,
	);
});
