import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	STALE_SESSION_MS,
	deriveWorkspaceKey,
	deriveWorkspaceLabel,
	enrichDashboardWithWorkspaces,
	groupSessionsByWorkspace,
	isSessionStale,
} from "../dist/session-routing.js";
import {
	archiveOhMyPiBackgroundSession,
	recoverOhMyPiBackgroundSession,
} from "../dist/agent-hub-actions.js";

function entry(overrides) {
	return {
		name: "s",
		current: false,
		isCurrent: false,
		ready: false,
		isReady: false,
		activity: "saved",
		aliases: [],
		...overrides,
	};
}

test("deriveWorkspace splits label (basename) from key (full path)", () => {
	assert.equal(deriveWorkspaceKey("C:\\dev\\repo\\"), "C:\\dev\\repo");
	assert.equal(deriveWorkspaceLabel("C:\\dev\\repo"), "repo");
	assert.equal(deriveWorkspaceLabel(undefined), "(no workspace)");
	assert.equal(deriveWorkspaceKey(undefined), undefined);
});

test("groupSessionsByWorkspace keeps same-basename dirs distinct by full path", () => {
	const sessions = [
		entry({ name: "a", workspace: "dist", workspaceKey: "C:\\one\\dist" }),
		entry({ name: "b", workspace: "dist", workspaceKey: "C:\\two\\dist" }),
		entry({ name: "c", workspace: "dist", workspaceKey: "C:\\one\\dist" }),
	];
	const groups = groupSessionsByWorkspace(sessions);
	assert.equal(groups.length, 2, "two distinct full-path groups despite shared basename");
	const byKey = new Map(groups.map((g) => [g.workspaceKey, g]));
	assert.equal(byKey.get("C:\\one\\dist").sessions.length, 2);
	assert.equal(byKey.get("C:\\two\\dist").sessions.length, 1);
});

test("isSessionStale respects the 24h boundary and never flags current", () => {
	const now = 1_000_000_000_000;
	assert.equal(isSessionStale(now - STALE_SESSION_MS - 1, now, false), true);
	assert.equal(isSessionStale(now - STALE_SESSION_MS + 1000, now, false), false);
	assert.equal(isSessionStale(now - STALE_SESSION_MS - 1, now, true), false, "current is never stale");
	assert.equal(isSessionStale(undefined, now, false), false);
});

test("enrichDashboardWithWorkspaces hides archived paths and marks stale", () => {
	const now = 1_000_000_000_000;
	const dashboard = {
		current: "none",
		ready: [],
		sessions: [
			entry({ name: "fresh", sessionPath: "/s/fresh.jsonl", cwd: "C:\\dev\\a", lastActivity: now - 1000 }),
			entry({ name: "old", sessionPath: "/s/old.jsonl", cwd: "C:\\dev\\b", lastActivity: now - STALE_SESSION_MS - 1 }),
			entry({ name: "hidden", sessionPath: "/s/hidden.jsonl", cwd: "C:\\dev\\a", lastActivity: now - 1000 }),
		],
	};
	const result = enrichDashboardWithWorkspaces(dashboard, { now, archivedPaths: ["/s/hidden.jsonl"] });
	const names = result.sessions.map((s) => s.name);
	assert.deepEqual(names.sort(), ["fresh", "old"], "archived path hidden");
	const byName = new Map(result.sessions.map((s) => [s.name, s]));
	assert.equal(byName.get("old").stale, true);
	assert.equal(byName.get("fresh").stale, false);
	assert.ok(Array.isArray(result.workspaces) && result.workspaces.length >= 1);
});

test("archive then recover round-trips an oh-my-pi background lane", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-nav-"));
	try {
		const sessionsRoot = join(tmp, "sessions");
		const projectDir = join(sessionsRoot, "C-dev-repo");
		mkdirSync(projectDir, { recursive: true });
		const sessionPath = join(projectDir, "2026-06-23T000000_lane.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "lane-1",
				cwd: "C:\\dev\\repo",
				backgroundInstance: { name: "scout", status: "active", model: "gpt-5" },
			})}\n`,
		);
		const env = { PI_SPEAK_OH_MY_PI_SESSIONS_ROOT: sessionsRoot };

		const archived = archiveOhMyPiBackgroundSession(sessionPath, env);
		assert.equal(archived.ok, true);
		assert.equal(JSON.parse(readFileSync(sessionPath, "utf8").split(/\r?\n/)[0]).backgroundInstance.status, "archived");

		const recovered = recoverOhMyPiBackgroundSession(sessionPath, env);
		assert.equal(recovered.ok, true);
		assert.match(recovered.message, /scout/);
		assert.equal(JSON.parse(readFileSync(sessionPath, "utf8").split(/\r?\n/)[0]).backgroundInstance.status, "active");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("recover rejects a non-archived lane", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-nav-"));
	try {
		const sessionsRoot = join(tmp, "sessions");
		const projectDir = join(sessionsRoot, "C-dev-repo");
		mkdirSync(projectDir, { recursive: true });
		const sessionPath = join(projectDir, "2026-06-23T000000_lane.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "lane-1",
				cwd: "C:\\dev\\repo",
				backgroundInstance: { name: "scout", status: "active", model: "gpt-5" },
			})}\n`,
		);
		const result = recoverOhMyPiBackgroundSession(sessionPath, { PI_SPEAK_OH_MY_PI_SESSIONS_ROOT: sessionsRoot });
		assert.equal(result.ok, false);
		assert.match(result.message, /not an archived/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
