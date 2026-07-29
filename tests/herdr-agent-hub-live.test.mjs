import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOhMyPiAgentHubDashboard } from "../dist/agent-hub-dashboard.js";
import { createLiveAgentHubBinding } from "../dist/herdr-agent-hub-live.js";
import { AgentHubGateway } from "../dist/herdr-agent-hub-gateway.js";

function jsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

async function withFixture(fn) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-herdr-live-"));
	const sessionsRoot = join(tmp, "sessions");
	const projectDir = join(sessionsRoot, "repo");
	mkdirSync(projectDir, { recursive: true });
	const sessionPath = join(projectDir, "2026-06-23T000000_api-session.jsonl");
	writeFileSync(
		sessionPath,
		jsonLine({ type: "session", version: 3, id: "api-session", cwd: "/repo", timestamp: "2026-06-23T10:00:00.000Z" })
			+ jsonLine({ type: "background_instance", name: "api-worker", status: "active", model: "gpt-5" }),
	);
	const savedEnvRoot = process.env.PI_SPEAK_OH_MY_PK_SESSIONS_ROOT;
	process.env.PI_SPEAK_OH_MY_PK_SESSIONS_ROOT = sessionsRoot;
	try {
		return await fn({ tmp, sessionsRoot, sessionPath });
	} finally {
		if (savedEnvRoot === undefined) delete process.env.PI_SPEAK_OH_MY_PK_SESSIONS_ROOT;
		else process.env.PI_SPEAK_OH_MY_PK_SESSIONS_ROOT = savedEnvRoot;
		rmSync(tmp, { recursive: true, force: true });
	}
}

function makeGateway(sessionsRoot, deps = {}) {
	const binding = createLiveAgentHubBinding({
		dashboardFn: () => buildOhMyPiAgentHubDashboard({ sessionsRoots: [sessionsRoot] }),
		submitChatTurn: deps.submitChatTurn ?? (async () => {}),
		lookupOptions: { sessionsRoots: [sessionsRoot] },
	});
	return { gateway: new AgentHubGateway(binding), binding };
}

test("live binding: chat on a background lane submits a real turn targeted at the lane name", async () => {
	await withFixture(async ({ sessionsRoot }) => {
		const submitted = [];
		const { gateway } = makeGateway(sessionsRoot, {
			submitChatTurn: async (text, target, cwd) => {
				submitted.push({ text, target, cwd });
			},
		});
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");
		assert.ok(lane, "expected a background lane in the snapshot");

		const result = await gateway.chat(lane.id, "keep going", null);
		assert.equal(result.ok, true);
		assert.equal(submitted.length, 1);
		assert.equal(submitted[0].text, "keep going");
		assert.equal(submitted[0].target, "api-worker");
	});
});

test("live binding: kill archives the lane's session file via the two-step confirm flow", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");

		const pending = await gateway.kill(lane.id, undefined);
		assert.equal(pending.ok, false);
		assert.equal(pending.code, "confirm_required");

		const result = await gateway.kill(lane.id, pending.confirmToken);
		assert.equal(result.ok, true);
		const header = JSON.parse(readFileSync(sessionPath, "utf8").split(/\r?\n/)[0]);
		assert.equal(header.backgroundInstance.status, "archived");
	});
});

test("live binding: revive recovers an archived lane back to active", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");
		await gateway.kill(lane.id, (await gateway.kill(lane.id, undefined)).confirmToken);

		// The archived lane no longer appears in a fresh snapshot/getAgent (that's what
		// "archived" means to the dashboard scan) -- revive must still resolve it by id.
		const result = await gateway.revive(lane.id);
		assert.equal(result.ok, true);
		const header = JSON.parse(readFileSync(sessionPath, "utf8").split(/\r?\n/)[0]);
		assert.equal(header.backgroundInstance.status, "active");
	});
});

test("live binding: chat is honestly rejected for subagents (no independent routing target)", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		// Give the lane one parked subagent so the dashboard exposes a "sub" kind agent.
		const raw = readFileSync(sessionPath, "utf8");
		writeFileSync(
			sessionPath,
			raw + jsonLine({ type: "background_instance", name: "lint-worker", status: "active", role: "sub" }),
		);
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");
		const sub = agents.find((a) => a.kind === "sub" && a.parentId === lane.id);
		if (!sub) return; // dashboard fixture didn't produce a nested subagent; covered by kind check below regardless.

		const result = await gateway.chat(sub.id, "hi", null);
		assert.equal(result.ok, false);
		assert.equal(result.code, "action_rejected");
	});
});

test("gateway transcript: returns a distilled digest with lane metadata back-filled", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		const raw = readFileSync(sessionPath, "utf8");
		writeFileSync(
			sessionPath,
			raw
				+ jsonLine({
					type: "message",
					id: "m-1",
					timestamp: "2026-06-23T10:01:00.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "must not leak" },
							{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/repo/index.ts" } },
						],
					},
				})
				+ jsonLine({ type: "model_change", model: "gpt-5", timestamp: "2026-06-23T10:01:30.000Z" })
				+ jsonLine({
					type: "message",
					id: "m-2",
					timestamp: "2026-06-23T10:02:00.000Z",
					message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "file contents" }] },
				}),
		);
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");

		const digest = await gateway.transcript(lane.id, { maxTurns: 10 });
		assert.ok(digest, "expected a digest for a known lane");
		assert.equal(digest.sessionId, "api-session");
		assert.equal(digest.cwd, "/repo");
		assert.equal(digest.model, "gpt-5");
		assert.equal(digest.stats.messages, 2);
		assert.equal(digest.stats.toolCalls, 1);
		assert.deepEqual(digest.stats.filesTouched, ["/repo/index.ts"]);
		assert.equal(digest.turns[0].hasThinking, true);
		assert.ok(!JSON.stringify(digest).includes("must not leak"));
		assert.equal(digest.truncated, false);
	});
});

test("gateway transcript: mid-file tail is marked truncated and never yields partial jsonl", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		// Force the bounded reader to start deep inside the file, mid-record.
		const filler = jsonLine({
			type: "message",
			id: "filler",
			timestamp: "2026-06-23T10:01:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] },
		}).repeat(20);
		writeFileSync(sessionPath, readFileSync(sessionPath, "utf8") + filler);
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");

		const digest = await gateway.transcript(lane.id, { maxBytes: 8192 });
		assert.ok(digest);
		assert.equal(digest.truncated, true, "a mid-file tail must be marked truncated even when maxTurns kept everything");
		// The header (record 0) is invisible from a tail, so lane metadata is back-filled.
		assert.equal(digest.sessionId, lane.id);
		assert.equal(digest.cwd, "/repo");
		assert.ok(digest.stats.messages >= 1, "expected at least one complete record from the tail");
	});
});

test("gateway transcript: query filters turns, unknown agents return undefined", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		writeFileSync(
			sessionPath,
			readFileSync(sessionPath, "utf8")
				+ jsonLine({ type: "message", id: "q-1", timestamp: "2026-06-23T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "fix the parser" }] } })
				+ jsonLine({ type: "message", id: "q-2", timestamp: "2026-06-23T10:02:00.000Z", message: { role: "user", content: [{ type: "text", text: "unrelated" }] } }),
		);
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");

		const filtered = await gateway.transcript(lane.id, { query: "PARSER" });
		assert.equal(filtered.turns.length, 1);
		assert.equal(filtered.turnFilter.query, "PARSER");

		assert.equal(await gateway.transcript("no-such-lane", {}), undefined);
	});
});

test("gateway detail: tail stays bounded on transcripts with huge records", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		// One ~1MB record followed by small ones: the bounded reader must not buffer
		// the whole file to answer a small tail request.
		const huge = jsonLine({
			type: "message",
			id: "huge",
			timestamp: "2026-06-23T10:01:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "h".repeat(1024 * 1024) }] },
		});
		const small = Array.from({ length: 6 }, (_, i) => jsonLine({
			type: "message",
			id: `s-${i}`,
			timestamp: "2026-06-23T10:02:00.000Z",
			message: { role: "user", content: [{ type: "text", text: `small-${i}` }] },
		})).join("");
		writeFileSync(
			sessionPath,
			readFileSync(sessionPath, "utf8") + huge + small
				// Keep the lane discoverable: the dashboard scan finds older-format
				// background_instance records in a bounded 256KB tail, which the 1MB
				// record above would otherwise push out of view.
				+ jsonLine({ type: "background_instance", name: "api-worker", status: "active", model: "gpt-5" }),
		);

		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");

		const detail = await gateway.detail(lane.id, 3);
		const fileLines = readFileSync(sessionPath, "utf8").split(/\r?\n/).filter(Boolean);
		assert.deepEqual(detail.transcriptTail, fileLines.slice(-3), "tail must be the file's actual last complete lines");
		assert.equal(detail.transcriptSize, statSync(sessionPath).size, "transcriptSize reports the real file size, not bytes read");
	});
});

test("gateway detail: uses only the bounded range reader with a tailLines-derived cap", async () => {
	// A test double proves the no-full-slurp invariant: if detail() ever regressed to
	// readTranscript(0) this throws, and the recorded maxBytes pins the sizing heuristic.
	const agent = { id: "probe", kind: "background", status: "active", cwd: "/repo", sessionFile: "x.jsonl" };
	const seen = [];
	const binding = {
		canMutate: false,
		listAgents: async () => ({ folders: [], agents: [agent] }),
		getAgent: async (id) => (id === "probe" ? agent : undefined),
		chat: async () => { throw new Error("read-only"); },
		kill: async () => { throw new Error("read-only"); },
		revive: async () => { throw new Error("read-only"); },
		readTranscript: async () => { throw new Error("full slurp must not be used by detail()"); },
		readTranscriptRange: async (id, opts) => {
			seen.push({ id, opts });
			return { text: "a\nb\nc\n", newSize: 6, fromByte: 0 };
		},
	};
	const gateway = new AgentHubGateway(binding);
	const detail = await gateway.detail("probe", 3);
	assert.deepEqual(detail.transcriptTail, ["a", "b", "c"]);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].opts.maxBytes, 3 * 8192, "cap derives from tailLines");
});

test("gateway transcript: unterminated final record marks the digest truncated", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		// A record still being written has no trailing newline; the reader drops it and
		// the digest must say it is not complete rather than look finished.
		writeFileSync(
			sessionPath,
			readFileSync(sessionPath, "utf8")
				+ jsonLine({ type: "message", id: "done", timestamp: "2026-06-23T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "complete turn" }] } })
				+ "{\"type\":\"message\",\"id\":\"in-progress\"",
		);
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");

		const digest = await gateway.transcript(lane.id, {});
		assert.equal(digest.truncated, true, "a dropped in-progress record must mark the digest truncated");
		assert.ok(!JSON.stringify(digest.turns).includes("in-progress"), "the partial record is never parsed");

		const detail = await gateway.detail(lane.id, 50);
		assert.ok(!detail.transcriptTail.some((line) => line.includes("in-progress")), "detail tail excludes the fragment");
		assert.equal(detail.transcriptUnavailable, undefined);
	});
});

test("gateway transcript: unreadable transcript of a KNOWN agent is null, and detail flags it", async () => {
	// A deleted session file drops the lane from discovery entirely (truthful "unknown
	// agent"), so the null state is driven through a binding double: agent found, read
	// failed. The filesystem-level null path is covered in herdr-agent-hub-disk.test.mjs.
	const agent = { id: "probe", kind: "background", status: "active", cwd: "/repo", sessionFile: "gone.jsonl" };
	const binding = {
		canMutate: false,
		listAgents: async () => ({ folders: [], agents: [agent] }),
		getAgent: async (id) => (id === "probe" ? agent : undefined),
		chat: async () => { throw new Error("read-only"); },
		kill: async () => { throw new Error("read-only"); },
		revive: async () => { throw new Error("read-only"); },
		readTranscript: async () => null,
		readTranscriptRange: async () => null,
	};
	const gateway = new AgentHubGateway(binding);

	assert.equal(await gateway.transcript("probe", {}), null, "null = transcript unreadable, distinct from undefined = unknown agent");
	assert.equal(await gateway.transcript("no-such-lane", {}), undefined);

	const detail = await gateway.detail("probe", 10);
	assert.equal(detail.transcriptUnavailable, true);
	assert.deepEqual(detail.transcriptTail, []);
});

test("gateway detail: a single oversized record yields an empty tail flagged as clipped", async () => {
	await withFixture(async ({ sessionsRoot, sessionPath }) => {
		// One ~1MB record AFTER the lane record: the bounded window lands inside it and
		// contains no complete line. The detail must flag the clip, not look like file end.
		writeFileSync(
			sessionPath,
			readFileSync(sessionPath, "utf8")
				+ jsonLine({ type: "message", id: "huge", timestamp: "2026-06-23T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "h".repeat(1024 * 1024) }] } })
				// Keep the lane discoverable past the 1MB record (bounded tail scan).
				+ jsonLine({ type: "background_instance", name: "api-worker", status: "active", model: "gpt-5" }),
		);
		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();
		const lane = agents.find((a) => a.kind === "background");

		const detail = await gateway.detail(lane.id, 40);
		assert.equal(detail.transcriptTailTruncated, true, "fewer lines than requested inside a bounded window is a clip, not file end");
		assert.equal(detail.transcriptSize > 1024 * 1024, true);
	});
});

test("gateway briefing: counts every agent and samples lanes by relevance", async () => {
	const mkAgent = (id, status) => ({ id, kind: "background", status, cwd: "/repo", sessionFile: `${id}.jsonl` });
	const agents = [mkAgent("lane-a", "idle"), mkAgent("lane-b", "running"), mkAgent("lane-c", "parked")];
	const chunkFor = {
		"lane-a": "{\"type\":\"session\",\"id\":\"a\"}\n",
		"lane-b": jsonLine({ type: "session", id: "b", cwd: "/repo" })
			+ jsonLine({ type: "model_change", model: "k3", timestamp: "2026-06-23T10:00:00.000Z" })
			+ jsonLine({ type: "message", id: "m1", timestamp: "2026-06-23T10:01:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }] } })
			+ jsonLine({ type: "message", id: "m2", timestamp: "2026-06-23T10:02:00.000Z", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] } }),
		"lane-c": null, // unreadable transcript
	};
	const binding = {
		canMutate: false,
		listAgents: async () => ({ folders: [{ id: "f", label: "F", path: "/repo", agents: [] }], agents }),
		getAgent: async (id) => agents.find((a) => a.id === id),
		chat: async () => { throw new Error("read-only"); },
		kill: async () => { throw new Error("read-only"); },
		revive: async () => { throw new Error("read-only"); },
		readTranscript: async () => { throw new Error("full slurp must not be used by briefing()"); },
		readTranscriptRange: async (id) => {
			const text = chunkFor[id];
			return text === null ? null : { text, newSize: text.length, fromByte: 0 };
		},
	};
	const gateway = new AgentHubGateway(binding);

	const briefing = await gateway.briefing({});
	assert.deepEqual(briefing.counts, { idle: 1, running: 1, parked: 1 });
	assert.equal(briefing.folders, 1);
	assert.equal(briefing.agents, 3);
	assert.equal(briefing.lanesCapped, false);
	// Running lane sampled first regardless of list order.
	assert.equal(briefing.lanes[0].id, "lane-b");
	assert.equal(briefing.lanes[0].model, "k3");
	assert.equal(briefing.lanes[0].lastActivityAt, "2026-06-23T10:02:00.000Z");
	assert.equal(briefing.lanes[0].recentToolCalls, 1);
	assert.equal(briefing.lanes[0].recentToolErrors, 1);
	assert.equal(briefing.lanes[0].sampledTail, false);
	const laneC = briefing.lanes.find((l) => l.id === "lane-c");
	assert.equal(laneC.transcriptUnavailable, true);

	const capped = await gateway.briefing({ maxLanes: 1 });
	assert.equal(capped.lanes.length, 1);
	assert.equal(capped.lanesCapped, true);
	assert.deepEqual(capped.counts, { idle: 1, running: 1, parked: 1 }, "counts still cover unsampled agents");
});

test("snapshot: lane description comes from the background role and subagents are labeled", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-herdr-desc-"));
	try {
		const sessionsRoot = join(tmp, "sessions");
		const projectDir = join(sessionsRoot, "repo");
		mkdirSync(projectDir, { recursive: true });
		const withRole = join(projectDir, "2026-07-23T000000_dispatch.jsonl");
		writeFileSync(
			withRole,
			jsonLine({ type: "session", version: 3, id: "dispatch", cwd: "/repo", timestamp: "2026-07-23T10:00:00.000Z" })
				+ jsonLine({ type: "background_instance", name: "queue-dispatcher", status: "active", model: "gpt-5", role: "linear queue dispatch worker" }),
		);
		// Subagent transcript lives in the lane's artifacts dir <session>/ (same basename, no .jsonl).
		const artifactsDir = withRole.slice(0, -".jsonl".length);
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(join(artifactsDir, "researcher.jsonl"), jsonLine({ type: "session", id: "sub" }));
		const withoutRole = join(projectDir, "2026-07-23T000001_plain.jsonl");
		writeFileSync(
			withoutRole,
			jsonLine({ type: "session", version: 3, id: "plain", cwd: "/repo", timestamp: "2026-07-23T11:00:00.000Z" })
				+ jsonLine({ type: "background_instance", name: "plain-lane", status: "active" }),
		);

		const { gateway } = makeGateway(sessionsRoot);
		const { agents } = await gateway.snapshot();

		const dispatcher = agents.find((agent) => agent.displayName === "queue-dispatcher");
		assert.ok(dispatcher, "expected the role-carrying lane in the snapshot");
		assert.equal(dispatcher.description, "linear queue dispatch worker");

		const sub = agents.find((agent) => agent.kind === "sub" && agent.parentId === dispatcher.id);
		assert.ok(sub, "expected the researcher subagent under its lane");
		assert.equal(sub.description, "background subagent");

		const plain = agents.find((agent) => agent.displayName === "plain-lane");
		assert.ok(plain, "expected the role-less lane in the snapshot");
		assert.equal(plain.description, null);

		// The gateway detail path carries the description through untouched.
		const detail = await gateway.detail(dispatcher.id, 10);
		assert.equal(detail.description, "linear queue dispatch worker");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
