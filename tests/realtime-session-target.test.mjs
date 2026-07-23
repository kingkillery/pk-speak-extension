import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
	buildRealtimeSessionCandidates,
	canonicalRealtimeSessionPath,
	resolveRealtimeSessionTarget,
	selectRealtimeCurrentTarget,
} from "../dist/realtime-session-target.js";

function dashboardEntry(overrides = {}) {
	return {
		name: "alpha",
		current: false,
		isCurrent: false,
		ready: false,
		isReady: false,
		activity: "saved",
		aliases: [],
		...overrides,
	};
}

function attentionSnapshot(overrides = {}) {
	return {
		sessionId: "sess-alpha",
		pid: 101,
		phase: "ready",
		waitingForAttention: false,
		aliases: [],
		updatedAt: 10,
		...overrides,
	};
}

function hubAgent(overrides = {}) {
	return {
		id: "hub-alpha",
		displayName: "alpha worker",
		kind: "background",
		parentId: null,
		folderKey: "repo",
		depth: 0,
		status: "running",
		model: null,
		cwd: null,
		activity: null,
		createdAtMs: 1,
		lastActivityMs: 2,
		needsAttention: false,
		attentionReason: null,
		sessionFile: null,
		...overrides,
	};
}

test("buildRealtimeSessionCandidates merges persisted, attention, and hub identity without losing aliases", () => {
	const lanePath = join(resolve("fixture-root"), "repo", "alpha.jsonl");
	const candidates = buildRealtimeSessionCandidates({
		dashboard: {
			sessions: [dashboardEntry({ name: "Alpha", sessionId: "sess-alpha", sessionPath: lanePath, cwd: "/repo/alpha", aliases: ["one"] })],
		},
		attentionSnapshots: [attentionSnapshot({ sessionName: "alpha runtime", sessionPath: lanePath, aliases: ["wake-alpha"] })],
		hubAgents: [hubAgent({ id: "hub-alpha", cwd: "/repo/hub", sessionFile: join(resolve("fixture-root"), "repo", "other.jsonl") })],
	});

	assert.equal(candidates.length, 2, "dashboard and attention records for one path must not become duplicate targets");
	const alpha = candidates.find((candidate) => candidate.sessionId === "sess-alpha");
	assert.ok(alpha);
	assert.deepEqual(alpha.sources.sort(), ["attention", "dashboard"]);
	assert.deepEqual(alpha.aliases.sort(), ["one", "wake-alpha"]);
	assert.equal(alpha.cwd, "/repo/alpha", "dashboard cwd is retained as the merged session cwd");
	assert.ok(alpha.names.includes("Alpha"));
	assert.ok(alpha.names.includes("alpha runtime"));
	const hub = candidates.find((candidate) => candidate.agentId === "hub-alpha");
	assert.ok(hub);
	assert.equal(hub.cwd, "/repo/hub");
});

test("resolveRealtimeSessionTarget applies exact identity precedence before names, aliases, and fragments", () => {
	const sources = {
		dashboard: {
			sessions: [dashboardEntry({ name: "alpha", sessionId: "session-1", aliases: ["one"] })],
		},
		hubAgents: [hubAgent({ id: "alpha", displayName: "worker" })],
	};

	const byAgentId = resolveRealtimeSessionTarget(" alpha ", sources);
	assert.equal(byAgentId.ok, true);
	if (byAgentId.ok) {
		assert.equal(byAgentId.match, "agent-id");
		assert.equal(byAgentId.candidate.agentId, "alpha");
	}

	const bySessionId = resolveRealtimeSessionTarget("session-1", sources);
	assert.equal(bySessionId.ok, true);
	if (bySessionId.ok) assert.equal(bySessionId.match, "session-id");

	const byAlias = resolveRealtimeSessionTarget("ONE", sources);
	assert.equal(byAlias.ok, true);
	if (byAlias.ok) assert.equal(byAlias.match, "alias");
});

test("resolveRealtimeSessionTarget canonicalizes paths and only accepts a unique fragment", () => {
	const root = resolve("fixture-root");
	const lanePath = join(root, "repo", "lane.jsonl");
	assert.equal(canonicalRealtimeSessionPath(join(root, "repo", "..", "repo", "lane.jsonl")), canonicalRealtimeSessionPath(lanePath));

	const byPath = resolveRealtimeSessionTarget(join(root, "repo", "..", "repo", "lane.jsonl"), {
		dashboard: { sessions: [dashboardEntry({ name: "lane", sessionPath: lanePath })] },
	});
	assert.equal(byPath.ok, true);
	if (byPath.ok) assert.equal(byPath.match, "path");

	const uniqueFragment = resolveRealtimeSessionTarget("lane-2", {
		dashboard: {
			sessions: [
				dashboardEntry({ name: "lane-one", sessionPath: join(root, "one.jsonl") }),
				dashboardEntry({ name: "lane-two", sessionPath: join(root, "lane-2.jsonl") }),
			],
		},
	});
	assert.equal(uniqueFragment.ok, true);
	if (uniqueFragment.ok) assert.equal(uniqueFragment.match, "fragment");

	const ambiguous = resolveRealtimeSessionTarget("lane", {
		dashboard: {
			sessions: [
				dashboardEntry({ name: "lane-one", sessionPath: join(root, "one.jsonl") }),
				dashboardEntry({ name: "lane-two", sessionPath: join(root, "two.jsonl") }),
			],
		},
	});
	assert.deepEqual(ambiguous, { ok: false, reason: "ambiguous", candidates: ambiguous.candidates });
	assert.equal(ambiguous.ok, false);
	assert.equal(ambiguous.candidates?.length, 2);
});

test("selectRealtimeCurrentTarget prioritizes selected connection, dashboard current, then exact lease snapshot", () => {
	const sources = {
		dashboard: {
			sessions: [
				dashboardEntry({ name: "dashboard-current", sessionId: "sess-dashboard", isCurrent: true }),
				dashboardEntry({ name: "selected", sessionId: "sess-selected" }),
			],
		},
		attentionSnapshots: [
			attentionSnapshot({ sessionId: "sess-not-owner", sessionName: "first snapshot" }),
			attentionSnapshot({ sessionId: "sess-owner", sessionName: "lease owner" }),
		],
		attentionLeader: { ownerSessionId: "sess-owner", pid: 202, updatedAt: 20 },
	};

	const selected = selectRealtimeCurrentTarget({ ...sources, selectedConnection: { sessionId: "sess-selected" } });
	assert.equal(selected.ok, true);
	if (selected.ok) {
		assert.equal(selected.match, "selected-connection");
		assert.equal(selected.candidate.name, "selected");
	}

	const dashboardCurrent = selectRealtimeCurrentTarget(sources);
	assert.equal(dashboardCurrent.ok, true);
	if (dashboardCurrent.ok) {
		assert.equal(dashboardCurrent.match, "dashboard-current");
		assert.equal(dashboardCurrent.candidate.sessionId, "sess-dashboard");
	}

	const leaseOwner = selectRealtimeCurrentTarget({
		...sources,
		dashboard: { sessions: sources.dashboard.sessions.map((entry) => ({ ...entry, isCurrent: false })) },
	});
	assert.equal(leaseOwner.ok, true);
	if (leaseOwner.ok) {
		assert.equal(leaseOwner.match, "lease");
		assert.equal(leaseOwner.candidate.sessionId, "sess-owner");
	}

	const noLeaseFallback = selectRealtimeCurrentTarget({
		attentionSnapshots: sources.attentionSnapshots,
		attentionLeader: { ownerSessionId: "missing", pid: 202, updatedAt: 20 },
	});
	assert.deepEqual(noLeaseFallback, { ok: false, reason: "not-found" });
});

test("selectRealtimeCurrentTarget does not fall back to the first snapshot when selected identity is stale", () => {
	const result = selectRealtimeCurrentTarget({
		attentionSnapshots: [attentionSnapshot({ sessionId: "sess-first" }), attentionSnapshot({ sessionId: "sess-second" })],
		selectedConnection: { sessionId: "sess-gone" },
	});
	assert.deepEqual(result, { ok: false, reason: "not-found" });
});


test("merged candidate carries attention source when a live snapshot backs the path (resume guard signal)", () => {
	const lanePath = join(resolve("fixture-root"), "repo", "live.jsonl");
	const candidates = buildRealtimeSessionCandidates({
		dashboard: {
			sessions: [dashboardEntry({ name: "live", sessionId: "sess-live", sessionPath: lanePath, activity: "background session" })],
		},
		attentionSnapshots: [attentionSnapshot({ sessionName: "live runtime", sessionPath: lanePath, sessionId: "snap-hash" })],
	});
	const candidate = candidates.find((entry) => entry.sessionId === "sess-live");
	assert.ok(candidate, "merged candidate should exist");
	assert.ok(candidate.sources.includes("attention"), "live snapshot must propagate attention source for resume guard");
	assert.equal(candidate.isCurrent, false);

	const persistedOnly = buildRealtimeSessionCandidates({
		dashboard: {
			sessions: [dashboardEntry({ name: "cold", sessionId: "sess-cold", sessionPath: lanePath, activity: "background session" })],
		},
	});
	const cold = persistedOnly.find((entry) => entry.sessionId === "sess-cold");
	assert.ok(cold);
	assert.ok(!cold.sources.includes("attention"), "cold on-disk session must not look live");
	assert.ok(!cold.isCurrent);
});

test("buildRealtimeSessionCandidates orders current first, then most recent activity", () => {
	const candidates = buildRealtimeSessionCandidates({
		dashboard: {
			sessions: [
				dashboardEntry({ name: "stale", sessionId: "sess-stale", sessionPath: "C:/s/stale.jsonl", lastActivity: 1_000 }),
				dashboardEntry({ name: "fresh", sessionId: "sess-fresh", sessionPath: "C:/s/fresh.jsonl", lastActivity: 3_000 }),
				dashboardEntry({ name: "active", sessionId: "sess-active", sessionPath: "C:/s/active.jsonl", lastActivity: 2_000, isCurrent: true }),
				dashboardEntry({ name: "undated", sessionId: "sess-undated", sessionPath: "C:/s/undated.jsonl" }),
			],
		},
	});
	assert.deepEqual(
		candidates.map((entry) => entry.name),
		["active", "fresh", "stale", "undated"],
	);
	assert.equal(candidates[0].lastActivity, 2_000);
});

test("merged candidates keep the newest lastActivity across sources", () => {
	const path = "C:/s/merge.jsonl";
	const candidates = buildRealtimeSessionCandidates({
		dashboard: {
			sessions: [
				dashboardEntry({ name: "lane", sessionId: "sess-merge", sessionPath: path, lastActivity: 1_000 }),
				dashboardEntry({ name: "lane-alias", sessionId: "sess-merge", sessionPath: path, lastActivity: 5_000 }),
			],
		},
	});
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].lastActivity, 5_000);
});