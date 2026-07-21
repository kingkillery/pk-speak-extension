// End-to-end dispatch test for the realtime conversational-assistant gateway.
//
// Everything else in tests/realtime-gateway.test.mjs exercises pure helpers
// (buildRealtimeTools, isNavigationalLaunch, looksLikeSecretPath, the approval
// registries) in isolation. None of that proves the ~700-line onmessage
// switch-case in realtime-gateway.ts actually wires those pieces together
// correctly at runtime. This file drives the real public entrypoint
// (handleRealtimeGateway) with a fake WebSocket and a fake Gemini Live
// connection, and asserts on what the gateway actually does: which tool
// calls get real read-only answers immediately, which get deferred behind
// tool_approval_required, what happens on command_approve/command_reject,
// and that approvals/executions land in the real audit trail on disk.
//
// Requires --experimental-test-module-mocks (see package.json's
// test:realtime-live script) to fake out @google/genai's network layer.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket as RealWebSocket } from "ws";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = await import("@google/genai");

class FakeLiveSession {
	constructor() {
		this.toolResponses = [];
		this.closed = false;
		this.clientContents = [];
	}
	sendToolResponse(payload) {
		this.toolResponses.push(payload);
	}
	sendClientContent(payload) { this.clientContents.push(payload); }
	sendRealtimeInput() {}
	close() {
		this.closed = true;
	}
}

// Each ai.live.connect() call (one per handleRealtimeGateway session) pushes
// a capture record here so a test can grab the callbacks Gemini would drive
// and the fake session it would call back on.
const connections = [];

class FakeGoogleGenAI {
	constructor(opts) {
		this.opts = opts;
		this.live = {
			connect: async ({ model, config, callbacks }) => {
				const session = new FakeLiveSession();
				connections.push({ model, config, callbacks, session });
				callbacks.onopen?.();
				return session;
			},
		};
	}
}

mock.module("@google/genai", {
	namedExports: { ...real, GoogleGenAI: FakeGoogleGenAI },
});

const { handleRealtimeGateway } = await import("../../dist/realtime-gateway.js");
const { getRealtimeTerminalAuditPath } = await import("../../dist/realtime-terminal-audit.js");

class FakeWebSocket extends EventEmitter {
	constructor() {
		super();
		this.readyState = RealWebSocket.OPEN;
		this.closeCode = undefined;
		this.sent = [];
	}
	send(data) {
		this.sent.push(data);
	}
	close(code, reason) {
		this.closeCode = code;
		this.readyState = RealWebSocket.CLOSED;
		this.emit("close", code, reason);
	}
	jsonMessages() {
		return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
	}
}

// Condition-based instead of a fixed sleep: this is an event-driven dispatch
// (message in, async handlers, message out), and a fixed-duration sleep is
// exactly the kind of thing that's fine on a fast local machine and flaky
// under slower/loaded CI scheduling. Poll for the actual observable effect
// instead, with a generous bound so a real hang still fails loudly.
async function waitFor(predicate, message, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(message);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// Forces the deterministic (non-narrated) launch_agent path: vertex backend
// makes nonBlockingEnabled false, so launch_agent calls activeSession.server
// .onSessionLaunch directly instead of spawning a real `ompk` child process.
function setVertexEnv() {
	process.env.PI_SPEAK_GEMINI_BACKEND = "vertex";
	process.env.GOOGLE_CLOUD_PROJECT = "fake-project";
	process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
}

test("does not mark the browser live session ready before Gemini setup completes", async () => {
	setVertexEnv();
	const ws = new FakeWebSocket();
	const before = connections.length;
	handleRealtimeGateway.call({}, ws);
	ws.emit("message", Buffer.from(JSON.stringify({ type: "noop" })), false);
	await waitFor(() => connections.length > before, "expected fake Gemini Live connection");
	assert.equal(ws.jsonMessages().some((message) => message.type === "start"), false);
	connections.at(-1).callbacks.onmessage({ setupComplete: true });
	await waitFor(() => ws.jsonMessages().some((message) => message.type === "start"), "expected start after Gemini setup");
});

async function startFakeSession(server) {
	const ws = new FakeWebSocket();
	const connectionCountBefore = connections.length;
	handleRealtimeGateway.call(server, ws);
	// Kick startNewSession immediately instead of waiting on its 500ms
	// no-first-message fallback timer; "noop" isn't a recognized control
	// message so replaying it after setup is a harmless no-op.
	ws.emit("message", Buffer.from(JSON.stringify({ type: "noop" })), false);
	await waitFor(() => connections.length > connectionCountBefore, "expected a fake Gemini Live connection to have been created");
	const connection = connections.at(-1);
	connection.callbacks.onmessage({ setupComplete: true });
	await waitFor(() => ws.jsonMessages().some((message) => message.type === "start"), "expected fake Gemini Live session setup");
	return { ws, connection };
}

async function startFakeConfiguredSession(server, cwd) {
	const ws = new FakeWebSocket();
	const connectionCountBefore = connections.length;
	handleRealtimeGateway.call(server, ws);
	ws.emit("message", Buffer.from(JSON.stringify({ type: "configure", cwd, clientSequenceId: 1 })), false);
	await waitFor(() => connections.length > connectionCountBefore, "expected a configured fake Gemini Live connection");
	connections.at(-1).callbacks.onmessage({ setupComplete: true });
	await waitFor(() => ws.jsonMessages().some((message) => message.type === "start"), "expected the configured live session to become ready");
	return { ws, connection: connections.at(-1) };
}

function lastToolResponse(connection) {
	const responses = connection.session.toolResponses;
	return responses.at(-1)?.functionResponses?.[0];
}

function readOutput(functionResponse) {
	return JSON.parse(functionResponse.response.output);
}

// The audit JSONL file is real and persists on disk across separate test
// *processes* (by design -- it's a durable trail), but the approval-id
// counter resets to 1 each process start. So a later run's "rt-cmd-2" can
// collide with a stale "rt-cmd-2" line from an earlier run. Reading only the
// bytes appended since a captured offset (rather than filtering the whole
// file by id) sidesteps that instead of relying on id uniqueness across runs.
function auditFileSize() {
	const path = getRealtimeTerminalAuditPath();
	return existsSync(path) ? statSync(path).size : 0;
}

function readNewAuditEvents(offsetBefore) {
	const path = getRealtimeTerminalAuditPath();
	if (!existsSync(path)) return [];
	const appended = readFileSync(path).subarray(offsetBefore).toString("utf8");
	return appended
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

test("configure binds the validated desktop workspace before tools run", async () => {
	setVertexEnv();
	const previousRoot = process.env.PI_SPEAK_WORKSPACE_ROOT;
	const root = mkdtempSync(join(tmpdir(), "pi-speak-live-workspace-"));
	const workspace = join(root, "project");
	mkdirSync(workspace);
	process.env.PI_SPEAK_WORKSPACE_ROOT = root;
	try {
		const { connection } = await startFakeConfiguredSession({}, workspace);
		await connection.callbacks.onmessage({
			toolCall: { functionCalls: [{ id: "call-workspace", name: "get_session_info", args: {} }] },
		});
		const output = readOutput(lastToolResponse(connection));
		assert.equal(output.currentCwd, workspace);
		const connectionCountBeforeReconnect = connections.length;
		await connection.callbacks.onmessage({ goAway: { timeLeft: "1s" } });
		await waitFor(() => connections.length > connectionCountBeforeReconnect, "expected upstream live reconnection");
		const reconnected = connections.at(-1);
		await reconnected.callbacks.onmessage({
			toolCall: { functionCalls: [{ id: "call-workspace-reconnected", name: "get_session_info", args: {} }] },
		});
		assert.equal(readOutput(lastToolResponse(reconnected)).currentCwd, workspace);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_SPEAK_WORKSPACE_ROOT;
		else process.env.PI_SPEAK_WORKSPACE_ROOT = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("client websocket reconnect resumes the existing live session", async () => {
	setVertexEnv();
	const connectionCountBefore = connections.length;
	const { ws } = await startFakeSession({});
	await waitFor(() => ws.jsonMessages().some((message) => message.type === "start"), "expected initial live start message");
	const start = ws.jsonMessages().find((message) => message.type === "start");
	const session = start.session;
	ws.emit("close", 1006, "network changed");

	const resumedWs = new FakeWebSocket();
	handleRealtimeGateway.call({}, resumedWs);
	resumedWs.emit("message", Buffer.from(JSON.stringify({ type: "reconnect", session, reconnectToken: start.reconnectToken, serverSequenceId: 0 })), false);
	await waitFor(() => resumedWs.jsonMessages().some((message) => message.type === "start"), "expected resumed live start message");
	assert.equal(connections.length, connectionCountBefore + 1, "websocket resume must not create another Gemini connection");
	resumedWs.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "after reconnect", clientSequenceId: 99 })), false);
	await waitFor(() => connections.at(-1).session.clientContents.some((entry) => entry.turns?.[0]?.parts?.[0]?.text === "after reconnect"), "expected resumed socket controls to reach the live session");
});

test("client websocket reconnect rejects a missing capability token", async () => {
	setVertexEnv();
	const { ws } = await startFakeSession({});
	const start = ws.jsonMessages().find((message) => message.type === "start");
	const attacker = new FakeWebSocket();
	handleRealtimeGateway.call({}, attacker);
	attacker.emit("message", Buffer.from(JSON.stringify({ type: "reconnect", session: start.session, serverSequenceId: 0 })), false);
	await waitFor(() => attacker.readyState === RealWebSocket.CLOSED, "expected invalid reconnect to close");
	assert.equal(attacker.closeCode, 1008);
	assert.equal(ws.readyState, RealWebSocket.OPEN, "original client must keep session ownership");
});

test("read-only tool: list_agent_hub_agents answers immediately with no approval step", async (t) => {
	setVertexEnv();
	const snapshot = { folders: [{ key: "root" }], agents: [{ id: "a1", name: "agent-one", status: "running" }] };
	const server = { agentHubGateway: { snapshot: async () => snapshot } };
	const { ws, connection } = await startFakeSession(server);
	// Deliberately not calling ws.close() here: the real gateway's ws "close"
	// handler starts a 60s (non-unref'd) reconnect-grace timer, which is fine
	// in a long-lived server but would stall this short-lived test process on
	// exit for no benefit -- the in-memory session dangling after the test
	// process exits is harmless.

	await connection.callbacks.onmessage({
		toolCall: { functionCalls: [{ id: "call-1", name: "list_agent_hub_agents", args: {} }] },
	});

	const fr = lastToolResponse(connection);
	assert.equal(fr.id, "call-1");
	const output = readOutput(fr);
	assert.equal(output.ok, true);
	assert.deepEqual(output.agents, snapshot.agents);
	assert.deepEqual(output.folders, snapshot.folders);

	const approvalMessages = ws.jsonMessages().filter((m) => m.type === "tool_approval_required");
	assert.equal(approvalMessages.length, 0, "a read-only tool must never require approval");
});

test("mutating tool: launch_agent defers behind approval, then actually launches on command_approve", async (t) => {
	setVertexEnv();
	const launchCalls = [];
	const server = {
		agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) },
		onSessionLaunch: async (payload) => {
			launchCalls.push(payload);
			return { ok: true, message: "launched", sessionPath: "/tmp/repo/new-session.jsonl" };
		},
	};
	const { ws, connection } = await startFakeSession(server);
	// Not calling ws.close() here -- see the comment on the first test above.
	const auditOffsetBefore = auditFileSize();

	await connection.callbacks.onmessage({
		toolCall: {
			functionCalls: [{ id: "call-launch", name: "launch_agent", args: { prompt: "fix the failing test", cwd: "/tmp/repo" } }],
		},
	});

	// Deferred: nothing executed, no tool response sent yet, but the client was told approval is required.
	assert.equal(launchCalls.length, 0, "must not launch before approval");
	assert.equal(connection.session.toolResponses.length, 0, "must not answer the tool call before approval");
	const approvalMsg = ws.jsonMessages().find((m) => m.type === "tool_approval_required");
	assert.ok(approvalMsg, "expected a tool_approval_required message");
	assert.match(approvalMsg.command, /fix the failing test/);
	const approvalId = approvalMsg.approvalId;
	assert.ok(approvalId);

	// Simulate the operator approving from the client.
	const responseCountBefore = connection.session.toolResponses.length;
	ws.emit("message", Buffer.from(JSON.stringify({ type: "command_approve", approvalId })), false);
	await waitFor(() => connection.session.toolResponses.length > responseCountBefore, "expected a tool response after command_approve");

	assert.equal(launchCalls.length, 1, "must launch exactly once after approval");
	// The coding agent receives the distilled task packet from the conversation
	// reducer, not the model's raw free-form prompt.
	assert.deepEqual(launchCalls[0], {
		prompt: "Goal: fix the failing test\n\nAction items:\n- fix the failing test\n\nOriginal transcript:\nfix the failing test",
		cwd: "/tmp/repo",
		hubOnly: undefined,
		targetNode: undefined,
	});

	const fr = lastToolResponse(connection);
	assert.equal(fr.id, "call-launch");
	const output = readOutput(fr);
	assert.equal(output.ok, true);
	assert.equal(output.message, "launched");

	const resolvedMsg = ws.jsonMessages().find((m) => m.type === "tool_approval_resolved" && m.approvalId === approvalId);
	assert.ok(resolvedMsg, "expected a tool_approval_resolved message");

	const auditEvents = readNewAuditEvents(auditOffsetBefore).filter((e) => e.approvalId === approvalId);
	const kinds = auditEvents.map((e) => e.kind);
	assert.deepEqual(kinds, ["command.approval_requested", "command.approval_resolved", "command.execution_result"]);
	assert.equal(auditEvents[0].commandKind, "launch_agent");
	assert.equal(auditEvents[2].result.ok, true);
});

test("mutating tool: launch_agent with a vague prompt answers with a clarification, never an approval or a launch", async (t) => {
	setVertexEnv();
	const launchCalls = [];
	const server = {
		agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) },
		onSessionLaunch: async (payload) => {
			launchCalls.push(payload);
			return { ok: true, message: "launched" };
		},
	};
	const { ws, connection } = await startFakeSession(server);
	// Not calling ws.close() here -- see the comment on the first test above.

	await connection.callbacks.onmessage({
		toolCall: {
			functionCalls: [{ id: "call-vague", name: "launch_agent", args: { prompt: "hmm", cwd: "/tmp/repo" } }],
		},
	});

	// The conversation reducer refuses to distill "hmm" into a task
	// (confidence below the dispatch floor, no action items), so the model
	// gets an immediate clarification result to speak -- nothing defers,
	// nothing mutates.
	assert.equal(launchCalls.length, 0, "must never launch a vague prompt");
	assert.equal(ws.jsonMessages().filter((m) => m.type === "tool_approval_required").length, 0, "a vague prompt must not open an approval");
	const fr = lastToolResponse(connection);
	assert.equal(fr.id, "call-vague");
	const output = readOutput(fr);
	assert.equal(output.ok, false);
	assert.equal(output.needsClarification, true);
	assert.match(output.message, /concrete action/i);
});

test("mutating tool: archive_session never runs when the operator rejects it", async (t) => {
	setVertexEnv();
	const archiveCalls = [];
	const server = {
		agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) },
		onSessionArchive: async (payload) => {
			archiveCalls.push(payload);
			return { ok: true, message: "archived" };
		},
	};
	const { ws, connection } = await startFakeSession(server);
	// Not calling ws.close() here -- see the comment on the first test above.
	const auditOffsetBefore = auditFileSize();

	await connection.callbacks.onmessage({
		toolCall: {
			functionCalls: [{ id: "call-archive", name: "archive_session", args: { sessionPath: "/tmp/repo/session.jsonl", action: "archive" } }],
		},
	});
	const approvalMsg = ws.jsonMessages().find((m) => m.type === "tool_approval_required");
	assert.ok(approvalMsg);

	const responseCountBefore = connection.session.toolResponses.length;
	ws.emit("message", Buffer.from(JSON.stringify({ type: "command_reject", approvalId: approvalMsg.approvalId })), false);
	await waitFor(() => connection.session.toolResponses.length > responseCountBefore, "expected a tool response after command_reject");

	assert.equal(archiveCalls.length, 0, "a rejected mutation must never execute");
	const fr = lastToolResponse(connection);
	assert.equal(fr.id, "call-archive");
	const output = readOutput(fr);
	assert.equal(output.ok, false);
	assert.equal(output.rejected, true);

	const auditEvents = readNewAuditEvents(auditOffsetBefore).filter((e) => e.approvalId === approvalMsg.approvalId);
	assert.deepEqual(
		auditEvents.map((e) => e.kind),
		["command.approval_requested", "command.approval_resolved", "command.execution_result"],
	);
	assert.equal(auditEvents[2].result.skipped, "rejected");
});

test("read_workspace_file: refuses a secret-shaped path without ever touching disk", async (t) => {
	setVertexEnv();
	const server = { agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) } };
	const { ws, connection } = await startFakeSession(server);
	// Not calling ws.close() here -- see the comment on the first test above.

	await connection.callbacks.onmessage({
		toolCall: {
			functionCalls: [{ id: "call-secret", name: "read_workspace_file", args: { path: "/tmp/definitely-does-not-exist/.env" } }],
		},
	});

	const fr = lastToolResponse(connection);
	const output = readOutput(fr);
	assert.equal(output.ok, false);
	assert.match(output.error, /secrets or credentials/);
	// No approval flow for reads either -- it's an outright refusal, not a mutation.
	assert.equal(ws.jsonMessages().filter((m) => m.type === "tool_approval_required").length, 0);
});

test("read_workspace_file: refuses an innocuously-named symlink that resolves to a secret file", async (t) => {
	setVertexEnv();
	const workspaceDir = mkdtempSync(join(tmpdir(), "pi-speak-dispatch-symlink-test-"));
	const previousRoot = process.env.PI_SPEAK_WORKSPACE_ROOT;
	process.env.PI_SPEAK_WORKSPACE_ROOT = workspaceDir;
	const secretPath = join(workspaceDir, ".env");
	writeFileSync(secretPath, "API_KEY=super-secret-value", "utf8");
	const symlinkPath = join(workspaceDir, "notes.txt");
	symlinkSync(secretPath, symlinkPath);
	t.after(() => {
		if (previousRoot === undefined) delete process.env.PI_SPEAK_WORKSPACE_ROOT;
		else process.env.PI_SPEAK_WORKSPACE_ROOT = previousRoot;
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	const server = { agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) } };
	const { ws, connection } = await startFakeSession(server);
	// Not calling ws.close() here -- see the comment on the first test above.

	await connection.callbacks.onmessage({
		toolCall: { functionCalls: [{ id: "call-symlink", name: "read_workspace_file", args: { path: symlinkPath } }] },
	});

	const fr = lastToolResponse(connection);
	const output = readOutput(fr);
	assert.equal(output.ok, false, "an innocuous-looking name must not bypass the secret-path refusal via a symlink");
	assert.match(output.error, /secrets or credentials/);
	assert.doesNotMatch(JSON.stringify(output), /super-secret-value/, "the secret content must never appear in the tool response");
});

test("read_workspace_file: returns real file content for an ordinary file under the workspace root", async (t) => {
	setVertexEnv();
	const workspaceDir = mkdtempSync(join(tmpdir(), "pi-speak-dispatch-test-"));
	const previousRoot = process.env.PI_SPEAK_WORKSPACE_ROOT;
	process.env.PI_SPEAK_WORKSPACE_ROOT = workspaceDir;
	const filePath = join(workspaceDir, "notes.txt");
	writeFileSync(filePath, "hello from disk", "utf8");
	t.after(() => {
		if (previousRoot === undefined) delete process.env.PI_SPEAK_WORKSPACE_ROOT;
		else process.env.PI_SPEAK_WORKSPACE_ROOT = previousRoot;
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	const server = { agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) } };
	const { ws, connection } = await startFakeSession(server);
	// Not calling ws.close() here -- see the comment on the first test above.

	await connection.callbacks.onmessage({
		toolCall: { functionCalls: [{ id: "call-read", name: "read_workspace_file", args: { path: filePath } }] },
	});

	const fr = lastToolResponse(connection);
	const output = readOutput(fr);
	assert.equal(output.ok, true);
	assert.equal(output.file.content, "hello from disk");
	assert.equal(output.file.binary, false);
});

test("read_workspace_file: model output is speech-shaped while the client keeps the full file", async (t) => {
	setVertexEnv();
	const workspaceDir = mkdtempSync(join(tmpdir(), "pi-speak-dispatch-shape-test-"));
	const previousRoot = process.env.PI_SPEAK_WORKSPACE_ROOT;
	process.env.PI_SPEAK_WORKSPACE_ROOT = workspaceDir;
	const filePath = join(workspaceDir, "big.txt");
	const fullContent = Array.from({ length: 200 }, (_, i) => `line ${i} of the big file`).join("\n");
	writeFileSync(filePath, fullContent, "utf8");
	t.after(() => {
		if (previousRoot === undefined) delete process.env.PI_SPEAK_WORKSPACE_ROOT;
		else process.env.PI_SPEAK_WORKSPACE_ROOT = previousRoot;
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	const server = { agentHubGateway: { snapshot: async () => ({ folders: [], agents: [] }) } };
	const { ws, connection } = await startFakeSession(server);

	await connection.callbacks.onmessage({
		toolCall: { functionCalls: [{ id: "call-big", name: "read_workspace_file", args: { path: filePath } }] },
	});

	// Model-facing FunctionResponse: clipped, summarized, discussable.
	const fr = lastToolResponse(connection);
	const output = readOutput(fr);
	assert.equal(output.ok, true);
	assert.equal(output.file.contentTruncatedForSpeech, true);
	assert.ok(output.file.content.length < fullContent.length, "model must not receive the full dump");
	assert.ok(!output.file.content.includes("line 199"), "tail must be clipped from the model view");
	assert.match(output.summary, /big\.txt/);
	assert.match(output.speechHint, /Never read JSON/i);

	// Client-facing tool_complete: full raw payload retained for the UI.
	const toolComplete = ws.jsonMessages().find((m) => m.type === "tool_complete" && m.name === "read_workspace_file");
	assert.ok(toolComplete, "expected a tool_complete message to the client");
	const clientOutput = JSON.parse(toolComplete.output);
	assert.equal(clientOutput.file.content, fullContent, "client must keep the full untruncated content");
});

test("session bridge selects locally and sends an approved OMPK message", async () => {
	setVertexEnv();
	const sentTurns = [];
	const dashboard = {
		current: "pk",
		ready: ["pk"],
		sessions: [{
			name: "pk",
			path: "C:/sessions/pk.jsonl",
			sessionPath: "C:/sessions/pk.jsonl",
			sessionId: "pk-session-id",
			provider: "oh-my-pk",
			cwd: "C:/work/pk",
			workingDirectory: "C:/work/pk",
			current: true,
			isCurrent: true,
			ready: true,
			isReady: true,
			activity: "idle",
			aliases: ["primary"],
		}],
	};
	const server = {
		realtimeBridge: {
			getSessionDashboard: () => dashboard,
			sendSessionTurn: async (text, target) => {
				sentTurns.push({ text, target });
				return { replyText: "OMPK accepted the task." };
			},
			agentHub: { snapshot: async () => ({ folders: [], agents: [] }) },
		},
	};
	const { ws, connection } = await startFakeSession(server);

	await connection.callbacks.onmessage({
		toolCall: { functionCalls: [{ id: "call-switch-pk", name: "switch_session", args: { name: "primary" } }] },
	});
	const switchComplete = ws.jsonMessages().find((message) => message.type === "tool_complete" && message.name === "switch_session");
	assert.ok(switchComplete);
	assert.equal(JSON.parse(switchComplete.output).target.sessionId, "pk-session-id");

	await connection.callbacks.onmessage({
		toolCall: { functionCalls: [{ id: "call-message-pk", name: "send_session_message", args: { text: "Review the failing test." } }] },
	});
	const approval = ws.jsonMessages().find((message) => message.type === "tool_approval_required" && message.name === "send_session_message");
	assert.ok(approval, "session message must wait for command approval");
	assert.equal(sentTurns.length, 0);

	ws.emit("message", Buffer.from(JSON.stringify({ type: "command_approve", approvalId: approval.approvalId })), false);
	await waitFor(() => sentTurns.length === 1, "expected approved message to reach OMPK bridge");
	assert.deepEqual(sentTurns[0], {
		text: "Review the failing test.",
		target: { name: "pk", agentId: undefined, sessionId: "pk-session-id", sessionPath: "C:/sessions/pk.jsonl", provider: "oh-my-pk", cwd: "C:/work/pk", aliases: ["primary"], sources: ["dashboard"] },
	});
	await waitFor(() => connection.session.toolResponses.some((entry) => entry.functionResponses?.[0]?.id === "call-message-pk"), "expected approved tool result");
});

test("resume_session precheck rejects a live (attention-backed) session and never requests approval", async (t) => {
	setVertexEnv();
	// Isolate the broker root so we can plant a live snapshot.
	const brokerRoot = mkdtempSync(join(tmpdir(), "pi-speak-resume-guard-"));
	const previousLocalAppData = process.env.LOCALAPPDATA;
	process.env.LOCALAPPDATA = brokerRoot;
	const sessionPath = "C:/sessions/active.jsonl";
	const { writeAttentionSnapshot } = await import("../../dist/attention-broker.js");
	writeAttentionSnapshot({
		sessionId: "snap-active",
		sessionName: "active",
		sessionPath,
		pid: 4242,
		phase: "ready",
		waitingForAttention: false,
		aliases: [],
		updatedAt: Date.now(),
	});
	t.after(() => {
		if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = previousLocalAppData;
		rmSync(brokerRoot, { recursive: true, force: true });
	});

	const dashboard = {
		current: "active",
		ready: ["active"],
		sessions: [{
			name: "active",
			path: sessionPath,
			sessionPath,
			sessionId: "active-header-id",
			provider: "oh-my-pk",
			cwd: "C:/work/active",
			workingDirectory: "C:/work/active",
			current: false,
			isCurrent: false,
			ready: false,
			isReady: false,
			activity: "background session",
			aliases: [],
		}],
	};
	const resumeCalls = [];
	const server = {
		realtimeBridge: {
			getSessionDashboard: () => dashboard,
			onSessionResume: async (payload) => {
				resumeCalls.push(payload);
				return { ok: true, message: "resumed" };
			},
			agentHub: { snapshot: async () => ({ folders: [], agents: [] }) },
		},
	};
	const { ws, connection } = await startFakeSession(server);

	await connection.callbacks.onmessage({
		toolCall: { functionCalls: [{ id: "call-resume-active", name: "resume_session", args: { target: "active" } }] },
	});

	// No approval must open; the precheck must answer immediately with session-already-active.
	assert.equal(resumeCalls.length, 0, "must never call onSessionResume for a live session");
	assert.equal(ws.jsonMessages().filter((m) => m.type === "tool_approval_required").length, 0, "live session must not open an approval");
	const fr = lastToolResponse(connection);
	assert.equal(fr.id, "call-resume-active");
	const output = readOutput(fr);
	assert.equal(output.ok, false);
	assert.equal(output.code, "session-already-active");
	assert.match(output.error, /currently running/i);
});
