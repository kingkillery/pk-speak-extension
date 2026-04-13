import test from "node:test";
import assert from "node:assert/strict";
import { BusyError, RemoteTurnManager } from "../dist/remote-turn-manager.js";

test("remote turn manager enforces one active plus two queued turns", async () => {
	const manager = new RemoteTurnManager({ maxQueued: 2 });
	const hold = [];
	const run = async (label) => {
		await new Promise((resolve) => hold.push(resolve));
		return { replyText: label };
	};

	const first = manager.enqueue("http-text", () => run("a"));
	const second = manager.enqueue("http-text", () => run("b"));
	const third = manager.enqueue("http-text", () => run("c"));

	await assert.rejects(
		() => manager.enqueue("http-text", () => run("d")),
		(error) => error instanceof BusyError,
	);

	while (hold.length > 0) {
		const release = hold.shift();
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	const results = await Promise.all([first, second, third]);
	assert.deepEqual(results.map((entry) => entry.replyText), ["a", "b", "c"]);
});
