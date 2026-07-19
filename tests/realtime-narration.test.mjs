import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
	REALTIME_SYSTEM_PROMPT,
	runWithProgressNarration,
	sendRealtimeToolResponse,
	summarizeAgentLine,
} from "../dist/realtime-gateway.js";

// Minimal fake ActiveSession capturing the FunctionResponses sent upstream.
function fakeActiveSession() {
	const sent = [];
	return {
		sent,
		serverSequenceId: 0,
		ws: { readyState: 1, send() {} },
		pendingServerMessages: [],
		pendingToolResponses: [],
		session: {
			sendToolResponse({ functionResponses }) {
				sent.push(...functionResponses);
			},
		},
	};
}

// Fake child process: stdout/stderr Readables + exit event.
function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	return child;
}

test("summarizeAgentLine collapses whitespace and caps length", () => {
	assert.equal(summarizeAgentLine("  planning   the   work \n"), "planning the work");
	const long = "x".repeat(200);
	assert.equal(summarizeAgentLine(long).length, 120);
	assert.ok(summarizeAgentLine(long).endsWith("..."));
});

test("runWithProgressNarration emits intermediate willContinue:true then final willContinue:false", async () => {
	const activeSession = fakeActiveSession();
	const child = fakeChild();
	const call = { id: "call-1", name: "launch_agent" };

	const done = runWithProgressNarration(activeSession, call, child);

	// meaningful line -> intermediate progress
	child.stdout.emit("data", Buffer.from("Planning phase started\n"));
	child.stdout.emit("data", Buffer.from("Executing step 1\n"));
	// non-meaningful, within 30s window -> no extra progress
	child.stdout.emit("data", Buffer.from("noise line\n"));
	child.emit("exit", 0);
	await done;

	const intermediate = activeSession.sent.filter((r) => r.willContinue === true);
	const finals = activeSession.sent.filter((r) => r.willContinue === false);

	assert.ok(intermediate.length >= 1, "at least one intermediate progress update");
	assert.equal(finals.length, 1, "exactly one final response");
	// all intermediates are WHEN_IDLE scheduled
	for (const r of intermediate) {
		assert.equal(r.scheduling, "WHEN_IDLE");
		assert.equal(r.id, "call-1");
		assert.ok(r.response.progress, "progress payload present");
	}
	assert.equal(finals[0].willContinue, false);
	assert.equal(finals[0].scheduling, "WHEN_IDLE");
	assert.equal(finals[0].response.done, true);
});

test("runWithProgressNarration caps in-flight progress (no backlog narration)", async () => {
	const activeSession = fakeActiveSession();
	const child = fakeChild();
	const call = { id: "call-2", name: "launch_agent" };
	const done = runWithProgressNarration(activeSession, call, child);

	// Several meaningful lines in the same tick: with MAX_INFLIGHT_PROGRESS=1 and
	// the 30s interval, only the first should narrate before the final.
	child.stdout.emit("data", Buffer.from("Planning\nExecuting\nError happened\nDone now\n"));
	child.emit("close", 0);
	await done;

	const intermediate = activeSession.sent.filter((r) => r.willContinue === true);
	assert.ok(intermediate.length <= 1, `expected <=1 intermediate, got ${intermediate.length}`);
});

test("runWithProgressNarration always sends a final response even with no output", async () => {
	const activeSession = fakeActiveSession();
	const child = fakeChild();
	const done = runWithProgressNarration(activeSession, { id: "c3", name: "launch_agent" }, child);
	child.emit("exit", 0);
	await done;
	const finals = activeSession.sent.filter((r) => r.willContinue === false);
	assert.equal(finals.length, 1);
	assert.equal(finals[0].response.done, true);
});

test("sendRealtimeToolResponse forwards scheduling and willContinue to the FunctionResponse", () => {
	const activeSession = fakeActiveSession();
	sendRealtimeToolResponse(activeSession, { id: "c1", name: "execute_terminal_command" }, "ok", {
		scheduling: "INTERRUPT",
	});
	assert.equal(activeSession.sent.length, 1);
	assert.equal(activeSession.sent[0].scheduling, "INTERRUPT");
	assert.equal(activeSession.sent[0].id, "c1");
	assert.deepEqual(activeSession.sent[0].response, { output: "ok" });
});

test("sendRealtimeToolResponse queues for delivery when the session is mid-reconnect", () => {
	const activeSession = fakeActiveSession();
	activeSession.session = null; // simulate disconnected upstream
	sendRealtimeToolResponse(activeSession, { id: "c2", name: "launch_agent" }, "done", {
		scheduling: "WHEN_IDLE",
	});
	assert.equal(activeSession.sent.length, 0, "nothing sent while disconnected");
	assert.equal(activeSession.pendingToolResponses.length, 1, "queued for after reconnect");
	assert.equal(activeSession.pendingToolResponses[0].id, "c2");
	assert.equal(activeSession.pendingToolResponses[0].scheduling, "WHEN_IDLE");
});

test("REALTIME_SYSTEM_PROMPT guides acknowledge-then-continue and no SILENT narration", () => {
	assert.match(REALTIME_SYSTEM_PROMPT, /acknowledge/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /continue the conversation/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /do not narrate/i);
});
