import test from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue } from "../dist/async-queue.js";

test("values pushed before next() are delivered in order", async () => {
	const q = new AsyncQueue();
	q.push("a");
	q.push("b");
	assert.deepEqual(await q.next(), { value: "a", done: false });
	assert.deepEqual(await q.next(), { value: "b", done: false });
});

test("a pending next() resolves when a value is pushed later", async () => {
	const q = new AsyncQueue();
	const pending = q.next();
	q.push("late");
	assert.deepEqual(await pending, { value: "late", done: false });
});

test("close() ends iteration for both buffered and pending consumers", async () => {
	const q = new AsyncQueue();
	const pending = q.next();
	q.close();
	assert.deepEqual(await pending, { value: undefined, done: true });
	// Subsequent reads keep reporting completion.
	assert.deepEqual(await q.next(), { value: undefined, done: true });
});

test("push() after close() is ignored", async () => {
	const q = new AsyncQueue();
	q.close();
	q.push("ignored");
	assert.deepEqual(await q.next(), { value: undefined, done: true });
});

test("fail() surfaces the error to a waiting consumer", async () => {
	const q = new AsyncQueue();
	const pending = q.next();
	q.fail(new Error("boom"));
	await assert.rejects(pending, /boom/);
});

test("fail() surfaces the error on the next read", async () => {
	const q = new AsyncQueue();
	q.fail(new Error("kaboom"));
	await assert.rejects(() => q.next(), /kaboom/);
});

test("works as an async iterable until closed", async () => {
	const q = new AsyncQueue();
	q.push(1);
	q.push(2);
	q.push(3);
	q.close();
	const seen = [];
	for await (const value of q) {
		seen.push(value);
	}
	assert.deepEqual(seen, [1, 2, 3]);
});
