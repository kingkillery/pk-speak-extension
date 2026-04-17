import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { requestGracefulChildShutdown } = await import("../dist/listener-control.js");

function makeProc() {
	const events = new EventEmitter();
	let stdinEnded = false;
	const writes = [];
	let killed = false;
	return {
		proc: {
			stdin: {
				write(value) {
					writes.push(value);
				},
				end() {
					stdinEnded = true;
				},
			},
			get killed() {
				return killed;
			},
			kill() {
				killed = true;
			},
			on(event, handler) {
				events.on(event, handler);
				return this;
			},
		},
		emitExit() {
			events.emit("exit", 0);
		},
		get writes() {
			return writes;
		},
		get stdinEnded() {
			return stdinEnded;
		},
		get killed() {
			return killed;
		},
	};
}

test("requestGracefulChildShutdown writes shutdown and closes stdin", () => {
	const fake = makeProc();
	const timer = requestGracefulChildShutdown(fake.proc, { command: "shutdown", killAfterMs: 50 });
	assert.ok(timer);
	assert.deepEqual(fake.writes, ["shutdown\n"]);
	assert.equal(fake.stdinEnded, true);
	clearTimeout(timer);
});

test("requestGracefulChildShutdown force-kills after timeout", async () => {
	const fake = makeProc();
	requestGracefulChildShutdown(fake.proc, { command: "shutdown", killAfterMs: 10 });
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(fake.killed, true);
});

test("requestGracefulChildShutdown clears force-kill when process exits first", async () => {
	const fake = makeProc();
	requestGracefulChildShutdown(fake.proc, { command: "shutdown", killAfterMs: 20 });
	fake.emitExit();
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal(fake.killed, false);
});
