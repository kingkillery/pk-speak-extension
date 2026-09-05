import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const { createSessionWorkspaceService, sessionIdForAgent } = await import("../dist/session-workspace.js");

const tempDirs = [];
after(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempMutationStorePath() {
	const dir = mkdtempSync(join(tmpdir(), "pi-speak-session-workspace-"));
	tempDirs.push(dir);
	return join(dir, "mutations.json");
}

function workspaceService(fake, deps = {}) {
	return createSessionWorkspaceService({ ...fake, mutationStorePath: tempMutationStorePath(), ...deps });
}

function herdrAgent(overrides = {}) {
	return {
		terminal_id: "term-1",
		name: "review-worker",
		agent: "claude",
		title: "Review worker",
		agent_status: "idle",
		agent_session: {
			source: "herdr:claude",
			agent: "claude",
			kind: "id",
			value: "claude-session-1",
		},
		workspace_id: "ws-1",
		tab_id: "tab-1",
		pane_id: "ws-1:tab-1:p1",
		focused: false,
		launch_pending: false,
		interactive_ready: true,
		state_change_seq: 7,
		cwd: "C:\\dev\\repo",
		revision: 12,
		...overrides,
	};
}

function client(overrides = {}) {
	const agent = herdrAgent();
	const state = {
		listCalls: 0,
		readCalls: [],
		promptCalls: [],
		focusCalls: [],
		listAgents: async () => {
			state.listCalls += 1;
			return { ok: true, executable: "herdr", agents: [agent] };
		},
		readAgent: async (target, lines) => {
			state.readCalls.push([target, lines]);
			return { ok: true, message: "read", text: "one\ntwo\nthree", truncated: false };
		},
		promptAgent: async (target, text) => {
			state.promptCalls.push([target, text]);
			return { ok: true, message: "prompted", agent: { ...agent, revision: agent.revision + 1 } };
		},
		focusAgent: async (target) => {
			state.focusCalls.push(target);
			return { ok: true, message: "focused", agent: { ...agent, focused: true, revision: agent.revision + 1 } };
		},
	};
	return { ...state, ...overrides };
}

test("snapshot exposes stable opaque live Herdr sessions", async () => {
	const fake = client();
	const service = workspaceService(fake, { now: () => 1000 });

	const snapshot = await service.snapshot();
	assert.equal(snapshot.source, "herdr");
	assert.equal(snapshot.available, true);
	assert.equal(snapshot.generatedAtMs, 1000);
	assert.equal(snapshot.sessions.length, 1);
	const session = snapshot.sessions[0];
	assert.equal(session.id, sessionIdForAgent(herdrAgent()));
	assert.match(session.id, /^s_[a-f0-9]{24}$/);
	assert.equal(session.provider, "claude");
	assert.equal(session.status, "idle");
	assert.equal(session.availability, "live");
	assert.equal(session.capabilities.prompt, true);
	assert.equal(session.capabilities.focus, true);
	assert.equal(session.capabilities.resume, true);
	assert.equal(session.workspaceId, undefined);
	assert.equal(session.tabId, undefined);
	assert.equal(session.paneId, undefined);
	assert.equal(session.terminalId, undefined);
	assert.equal(session.nativeSession.value, undefined);
});

test("session ids follow the native session across Herdr pane moves", () => {
	const first = herdrAgent();
	const moved = herdrAgent({
		terminal_id: "term-2",
		workspace_id: "ws-2",
		tab_id: "tab-2",
		pane_id: "ws-2:tab-2:p9",
	});
	assert.equal(sessionIdForAgent(first), sessionIdForAgent(moved));
	const anonymous = herdrAgent({ agent_session: undefined });
	const anonymousMoved = herdrAgent({ agent_session: undefined, pane_id: "ws-1:tab-1:p2" });
	assert.notEqual(sessionIdForAgent(anonymous), sessionIdForAgent(anonymousMoved));
});

test("detail resolves an opaque session id and returns a bounded tail", async () => {
	const fake = client();
	const service = workspaceService(fake);
	const id = sessionIdForAgent(herdrAgent());
	const result = await service.detail(id, 2);
	assert.equal(result.ok, true);
	assert.deepEqual(fake.readCalls, [["ws-1:tab-1:p1", 2]]);
	assert.deepEqual(result.detail.tail.lines, ["two", "three"]);
	assert.equal(result.detail.session.id, id);
});

test("prompt requires idempotency and expected revision guards", async () => {
	const service = workspaceService(client());
	const id = sessionIdForAgent(herdrAgent());
	const missingKey = await service.prompt(id, "continue", 12, undefined);
	assert.equal(missingKey.status, 400);
	assert.equal(missingKey.code, "idempotency_key_required");
	const missingRevision = await service.prompt(id, "continue", undefined, "key-1");
	assert.equal(missingRevision.status, 400);
	assert.equal(missingRevision.code, "expected_revision_required");
});

test("prompt replays the same idempotency key once and rejects payload reuse", async () => {
	const fake = client();
	const service = workspaceService(fake);
	const id = sessionIdForAgent(herdrAgent());
	const first = await service.prompt(id, "continue", 12, "key-1");
	assert.equal(first.ok, true);
	assert.equal(first.session.revision, 13);
	assert.equal(fake.promptCalls.length, 1);

	const replay = await service.prompt(id, "continue", 12, "key-1");
	assert.equal(replay.ok, true);
	assert.equal(replay.replayed, true);
	assert.equal(replay.commandId, first.commandId);
	assert.equal(fake.promptCalls.length, 1);

	const conflict = await service.prompt(id, "different", 12, "key-1");
	assert.equal(conflict.status, 409);
	assert.equal(conflict.code, "idempotency_conflict");
	assert.equal(fake.promptCalls.length, 1);

	const changedRevision = await service.prompt(id, "continue", 13, "key-1");
	assert.equal(changedRevision.status, 409);
	assert.equal(changedRevision.code, "idempotency_conflict");
	assert.equal(fake.promptCalls.length, 1);
});

test("unknown mutation outcomes block same-key retries without duplicating", async () => {
	const fake = client({
		promptAgent: async () => ({ ok: false, message: "timed out", code: "timeout" }),
	});
	let calls = 0;
	const tracked = {
		...fake,
		promptAgent: async (target, text) => {
			calls += 1;
			return fake.promptAgent(target, text);
		},
	};
	const service = workspaceService(tracked);
	const id = sessionIdForAgent(herdrAgent());
	const first = await service.prompt(id, "continue", 12, "unknown-key");
	assert.equal(first.status, 502);
	const retry = await service.prompt(id, "continue", 12, "unknown-key");
	assert.equal(retry.status, 503);
	assert.equal(retry.code, "mutation_outcome_unknown");
	assert.equal(calls, 1);
});

test("definite Herdr rejections clear the pending mutation for a safe retry", async () => {
	let calls = 0;
	const fake = client({
		promptAgent: async () => {
			calls += 1;
			return { ok: false, message: "agent is not ready", code: "agent_not_ready" };
		},
	});
	const service = workspaceService(fake);
	const id = sessionIdForAgent(herdrAgent());
	const first = await service.prompt(id, "continue", 12, "reject-key");
	assert.equal(first.status, 409);
	const retry = await service.prompt(id, "continue", 12, "reject-key");
	assert.equal(retry.status, 409);
	assert.equal(calls, 2);
});

test("concurrent mutations are serialized through revision checks", async () => {
	const base = herdrAgent();
	let revision = 12;
	let inFlight = 0;
	let calls = 0;
	const fake = client({
		listAgents: async () => ({ ok: true, executable: "herdr", agents: [{ ...base, revision }] }),
		promptAgent: async () => {
			calls += 1;
			inFlight += 1;
			assert.equal(inFlight, 1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			revision = 13;
			inFlight -= 1;
			return { ok: true, message: "prompted", agent: { ...base, revision } };
		},
	});
	const service = workspaceService(fake);
	const id = sessionIdForAgent(base);
	const results = await Promise.all([
		service.prompt(id, "first", 12, "concurrent-1"),
		service.prompt(id, "second", 12, "concurrent-2"),
	]);
	assert.equal(results.filter((result) => result.ok).length, 1);
	assert.equal(results.filter((result) => !result.ok && result.status === 412).length, 1);
	assert.equal(calls, 1);
});

test("prompt rejects a stale expected revision before dispatch", async () => {
	const fake = client();
	const service = workspaceService(fake);
	const result = await service.prompt(sessionIdForAgent(herdrAgent()), "continue", 11, "key-1");
	assert.equal(result.status, 412);
	assert.equal(result.code, "revision_mismatch");
	assert.equal(fake.promptCalls.length, 0);
});

test("focus uses the resolved Herdr pane target, not a client-supplied title", async () => {
	const fake = client();
	const service = workspaceService(fake);
	const result = await service.focus(sessionIdForAgent(herdrAgent()), 12, "focus-1");
	assert.equal(result.ok, true);
	assert.deepEqual(fake.focusCalls, ["ws-1:tab-1:p1"]);
	assert.equal(result.session.focused, true);
});

test("resume of an active native session is an idempotent focus no-op", async () => {
	const fake = client();
	const service = workspaceService(fake);
	const result = await service.resume(sessionIdForAgent(herdrAgent()), 12, "resume-1");
	assert.equal(result.ok, true);
	assert.equal(result.alreadyActive, true);
	assert.deepEqual(fake.focusCalls, ["ws-1:tab-1:p1"]);
});

test("prompt idempotency survives a gateway restart", async () => {
	const storePath = tempMutationStorePath();
	const firstFake = client();
	const firstService = createSessionWorkspaceService({ ...firstFake, mutationStorePath: storePath });
	const id = sessionIdForAgent(herdrAgent());
	const first = await firstService.prompt(id, "continue", 12, "restart-key");
	assert.equal(first.ok, true);

	const focus = await firstService.focus(id, 12, "focus-key");
	assert.equal(focus.ok, true);

	const stored = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(stored.version, 1);
	assert.equal(stored.mutations.length, 2);
	assert.equal(stored.mutations[0].key, "restart-key");

	const secondFake = client();
	const secondService = createSessionWorkspaceService({ ...secondFake, mutationStorePath: storePath });
	const replay = await secondService.prompt(id, "continue", 12, "restart-key");
	assert.equal(replay.ok, true);
	assert.equal(replay.replayed, true);
	assert.equal(replay.commandId, first.commandId);
	assert.equal(secondFake.promptCalls.length, 0);
});

test("invalid mutation store fails explicitly", () => {
	const storePath = tempMutationStorePath();
	writeFileSync(storePath, "not json", "utf8");
	assert.throws(
		() => createSessionWorkspaceService({ ...client(), mutationStorePath: storePath }),
		/Invalid session mutation store/,
	);
});

test("stream emits session and tail SSE events", async () => {
	const service = workspaceService(client());
	const response = new class extends EventEmitter {
		headers = {};
		body = "";
		writableEnded = false;
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
			return this;
		}
		write(chunk) {
			this.body += chunk;
			if (this.body.includes("event: tail") && !this.writableEnded) {
				this.writableEnded = true;
				this.emit("close");
			}
			return true;
		}
		end() {
			this.writableEnded = true;
			this.emit("close");
		}
	}();

	await service.stream(sessionIdForAgent(herdrAgent()), response, 2);
	assert.equal(response.status, 200);
	assert.equal(response.headers["Content-Type"], "text/event-stream");
	assert.match(response.body, /event: session/);
	assert.match(response.body, /event: tail/);
	assert.match(response.body, /\"id\":\"s_/);
	assert.doesNotMatch(response.body, /paneId|workspaceId|tabId|terminalId|claude-session-1/);
});

test("Herdr unavailability is explicit and never fabricates sessions", async () => {
	const service = workspaceService({
		listAgents: async () => ({ ok: false, executable: "herdr", code: "spawn_failed", error: "herdr not found" }),
		readAgent: async () => ({ ok: false, message: "unused" }),
		promptAgent: async () => ({ ok: false, message: "unused" }),
		focusAgent: async () => ({ ok: false, message: "unused" }),
	});
	const snapshot = await service.snapshot();
	assert.equal(snapshot.available, false);
	assert.equal(snapshot.sessions.length, 0);
	const detail = await service.detail(sessionIdForAgent(herdrAgent()), 10);
	assert.equal(detail.status, 503);
	assert.equal(detail.code, "herdr_unavailable");
});
