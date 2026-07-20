// Integration: the real handleRealtimeGateway running against the REAL
// simulated Gemini Live backend (PI_SPEAK_GEMINI_BACKEND=simulated).
//
// Unlike realtime-gateway-dispatch.test.mjs, this file uses NO module mocks:
// createGeminiClient itself returns the in-process simulator, so this proves
// the production seam (gemini-live-turn.ts backend selection -> startNewSession
// -> ai.live.connect) end to end — start gating, transcript + binary 24 kHz
// PCM framing, and a scenario-scripted tool call flowing through the genuine
// approval gate — all with zero Google credentials in the environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket as RealWebSocket } from "ws";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Backend selection is read from process.env at session-start time; make this
// process keyless on purpose so any accidental real-SDK path fails loudly.
process.env.PI_SPEAK_GEMINI_BACKEND = "simulated";
process.env.PI_SPEAK_SIM_TIMESCALE = "0";
delete process.env.PI_SPEAK_GEMINI_LIVE_MODEL;
delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.PI_SPEAK_VERTEX_API_KEY;
delete process.env.GOOGLE_CLOUD_PROJECT;
delete process.env.GOOGLE_CLOUD_LOCATION;
delete process.env.PI_SPEAK_SIM_SCENARIO;

const { handleRealtimeGateway } = await import("../../dist/realtime-gateway.js");
const { isGeminiLiveConfigured, isGeminiLiveSimulated } = await import("../../dist/gemini-live-turn.js");

class FakeWebSocket extends EventEmitter {
	constructor() {
		super();
		this.readyState = RealWebSocket.OPEN;
		this.sent = [];
	}
	send(data) {
		this.sent.push(data);
	}
	close(code, reason) {
		this.readyState = RealWebSocket.CLOSED;
		this.emit("close", code, reason);
	}
	jsonMessages() {
		return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
	}
	binaryFrames() {
		return this.sent.filter((d) => Buffer.isBuffer(d) || d instanceof Uint8Array).map((d) => Buffer.from(d));
	}
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(message);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// Deliberately never calling ws.close() in these tests: the gateway's close
// handler arms a 60s non-unref'd reconnect-grace timer (fine in a long-lived
// server, pointless stall in a short-lived test process). Same convention as
// realtime-gateway-dispatch.test.mjs.
async function startSimulatedSession(server) {
	const ws = new FakeWebSocket();
	handleRealtimeGateway.call(server, ws);
	ws.emit("message", Buffer.from(JSON.stringify({ type: "noop" })), false);
	await waitFor(() => ws.jsonMessages().some((m) => m.type === "start"), "expected start from the simulated backend");
	return ws;
}

test("simulated backend reports configured without any Google credentials", () => {
	assert.equal(isGeminiLiveSimulated(), true);
	assert.equal(isGeminiLiveConfigured(), true);
});

test("gateway brings a live session up against the simulator with no mocks", async () => {
	const ws = await startSimulatedSession({});
	const start = ws.jsonMessages().find((m) => m.type === "start");
	assert.ok(start.session, "start must carry a session id");
});

test("text turn streams an echo transcript and sequenced 24 kHz PCM frames", async () => {
	const ws = await startSimulatedSession({});
	ws.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "hello simulator", clientSequenceId: 2 })), false);

	await waitFor(
		() => ws.jsonMessages().some((m) => m.type === "transcript_complete"),
		"expected the simulated turn to finish with transcript_complete",
	);

	const transcriptText = ws
		.jsonMessages()
		.filter((m) => m.type === "transcript" && typeof m.text === "string")
		.map((m) => m.text)
		.join("");
	assert.match(transcriptText, /hello simulator/, "echo scenario must speak the user's words back");

	const frames = ws.binaryFrames();
	assert.ok(frames.length >= 1, "expected at least one binary audio frame");
	let previousSequence = 0;
	for (const frame of frames) {
		assert.ok(frame.length > 4, "audio frame must carry PCM beyond the 4-byte header");
		assert.equal((frame.length - 4) % 2, 0, "PCM16 payload must be an even byte count");
		const sequence = frame.readInt32BE(0);
		assert.ok(sequence > previousSequence, "server sequence ids must be strictly increasing across binary frames");
		previousSequence = sequence;
	}
});

test("scenario tool call defers behind the real approval gate and completes on command_approve", async () => {
	const scenarioDir = mkdtempSync(join(tmpdir(), "pi-speak-sim-scenario-"));
	const scenarioPath = join(scenarioDir, "scenario.json");
	writeFileSync(
		scenarioPath,
		JSON.stringify({
			name: "launch-approval",
			turns: [
				{
					match: "deploy",
					response: "Launching now.",
					audio: false,
					toolCall: { name: "launch_agent", args: { prompt: "fix the failing test", cwd: "/tmp/repo" } },
				},
			],
			fallback: { response: "fallback reply", audio: false },
		}),
	);
	process.env.PI_SPEAK_SIM_SCENARIO = scenarioPath;
	try {
		const launchCalls = [];
		const server = {
			agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) },
			onSessionLaunch: async (payload) => {
				launchCalls.push(payload);
				return { ok: true, message: "launched", sessionPath: "/tmp/repo/new-session.jsonl" };
			},
		};
		const ws = await startSimulatedSession(server);
		ws.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "please deploy the fix", clientSequenceId: 2 })), false);

		await waitFor(
			() => ws.jsonMessages().some((m) => m.type === "tool_approval_required"),
			"expected the scripted launch_agent call to require approval",
		);
		assert.equal(launchCalls.length, 0, "must not launch before approval");
		const approval = ws.jsonMessages().find((m) => m.type === "tool_approval_required");
		assert.ok(approval.approvalId);

		ws.emit("message", Buffer.from(JSON.stringify({ type: "command_approve", approvalId: approval.approvalId })), false);

		await waitFor(
			() => ws.jsonMessages().some((m) => m.type === "tool_complete" && m.name === "launch_agent"),
			"expected tool_complete after approving the simulated launch",
		);
		assert.equal(launchCalls.length, 1, "must launch exactly once after approval");
		assert.ok(
			ws.jsonMessages().some((m) => m.type === "tool_approval_resolved" && m.approvalId === approval.approvalId),
			"expected tool_approval_resolved for the approved call",
		);

		// The simulator holds the spoken reply until the tool response lands,
		// so the loop only closes if the gateway's sendToolResponse reached it.
		await waitFor(
			() =>
				ws
					.jsonMessages()
					.filter((m) => m.type === "transcript" && typeof m.text === "string")
					.map((m) => m.text)
					.join("")
					.includes("Launching now."),
			"expected the held scenario reply to stream after the tool response",
		);
	} finally {
		delete process.env.PI_SPEAK_SIM_SCENARIO;
	}
});
