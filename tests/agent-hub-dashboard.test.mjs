import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildOhMyPiAgentHubDashboard,
	mergeOhMyPiAgentHubSessions,
} from "../dist/agent-hub-dashboard.js";
import { archiveOhMyPiBackgroundSession } from "../dist/agent-hub-actions.js";

function jsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

test("buildOhMyPiAgentHubDashboard exposes active Oh-my-pk background lanes", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-agent-hub-"));
	try {
		// Given
		const sessionsRoot = join(tmp, "sessions");
		const projectDir = join(sessionsRoot, "C-dev-repo");
		mkdirSync(projectDir, { recursive: true });
		const activeSession = join(projectDir, "2026-06-23T000000_api-session.jsonl");
		const activeArtifacts = activeSession.slice(0, -".jsonl".length);
		mkdirSync(activeArtifacts, { recursive: true });
		writeFileSync(join(activeArtifacts, "lint-worker.jsonl"), jsonLine({ type: "message", text: "ok" }));
		writeFileSync(join(activeArtifacts, "__advisor.jsonl"), jsonLine({ type: "message", text: "ignore" }));
		writeFileSync(
			activeSession,
			jsonLine({
				type: "session",
				version: 3,
				id: "api-session",
				cwd: "C:\\dev\\repo",
				timestamp: "2026-06-23T10:00:00.000Z",
			})
				+ jsonLine({
					type: "background_instance",
					name: "api-worker",
					status: "active",
					model: "gpt-5",
					role: "reviewer",
				}),
		);
		writeFileSync(
			join(projectDir, "2026-06-23T010000_old-session.jsonl"),
			jsonLine({
				type: "session",
				version: 3,
				id: "old-session",
				cwd: "C:\\dev\\repo",
				backgroundInstance: { name: "old-worker", status: "archived" },
			}),
		);

		// When
		const dashboard = buildOhMyPiAgentHubDashboard({
			sessionsRoots: [sessionsRoot],
			now: () => 123456,
		});

		// Then
		assert.equal(dashboard.current, "oh-my-pk");
		assert.deepEqual(dashboard.ready, []);
		assert.equal(dashboard.storePath, sessionsRoot);
		assert.equal(dashboard.sessions.length, 1);
		const lane = dashboard.sessions[0];
		assert.equal(lane.name, "api-worker");
		assert.equal(lane.path, activeSession);
		assert.equal(lane.sessionPath, activeSession);
		assert.equal(lane.provider, "oh-my-pk");
		assert.equal(lane.sessionId, "api-session");
		assert.equal(lane.resumable, true);
		assert.deepEqual(lane.resumeCommand, ["ompk", "--resume", "api-session"]);
		assert.equal(lane.workingDirectory, "C:\\dev\\repo");
		assert.equal(lane.kind, "background");
		assert.equal(lane.source, "oh-my-pk");
		assert.equal(lane.model, "gpt-5");
		assert.equal(lane.role, "reviewer");
		assert.equal(lane.activity, "background session - gpt-5");
		assert.equal(lane.createdAt, Date.parse("2026-06-23T10:00:00.000Z"));
		assert.equal(lane.lastActivity > 0, true);
		assert.deepEqual(lane.subagents.map((subagent) => subagent.name), ["lint-worker"]);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("mergeOhMyPiAgentHubSessions appends background lanes without replacing route sessions", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-agent-hub-"));
	try {
		// Given
		const sessionsRoot = join(tmp, "sessions");
		const projectDir = join(sessionsRoot, "C-dev-repo");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "2026-06-23T000000_bg-session.jsonl"),
			jsonLine({
				type: "session",
				version: 3,
				id: "bg-session",
				cwd: "C:\\dev\\repo",
				backgroundInstance: { name: "scout", status: "active" },
			}),
		);
		const baseDashboard = {
			current: "Main",
			ready: ["Ready"],
			storePath: "session-routing.json",
			sessions: [
				{
					name: "Ready",
					path: "C:\\dev\\ready.jsonl",
					sessionPath: "C:\\dev\\ready.jsonl",
					current: false,
					isCurrent: false,
					ready: true,
					isReady: true,
					activity: "idle",
					aliases: [],
				},
			],
		};

		// When
		const merged = mergeOhMyPiAgentHubSessions(baseDashboard, {
			sessionsRoots: [sessionsRoot],
			now: () => 123456,
		});

		// Then
		assert.equal(merged.current, "Main");
		assert.deepEqual(merged.ready, ["Ready"]);
		assert.equal(merged.sessions.length, 2);
		assert.equal(merged.sessions[0].name, "Ready");
		assert.equal(merged.sessions[1].name, "scout");
		assert.equal(merged.sessions[1].source, "oh-my-pk");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("archiveOhMyPiBackgroundSession drops an Oh-my-pk lane from later scans", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-agent-hub-"));
	try {
		// Given
		const sessionsRoot = join(tmp, "sessions");
		const projectDir = join(sessionsRoot, "C-dev-repo");
		mkdirSync(projectDir, { recursive: true });
		const sessionPath = join(projectDir, "2026-06-23T000000_bg-session.jsonl");
		writeFileSync(
			sessionPath,
			jsonLine({
				type: "session",
				version: 3,
				id: "bg-session",
				cwd: "C:\\dev\\repo",
				backgroundInstance: { name: "scout", status: "active", model: "gpt-5" },
			}),
		);
		assert.equal(buildOhMyPiAgentHubDashboard({ sessionsRoots: [sessionsRoot] }).sessions.length, 1);

		// When
		const result = archiveOhMyPiBackgroundSession(sessionPath, { PI_SPEAK_OH_MY_PK_SESSIONS_ROOT: sessionsRoot });

		// Then
		assert.equal(result.ok, true);
		assert.match(result.message, /scout/);
		assert.equal(buildOhMyPiAgentHubDashboard({ sessionsRoots: [sessionsRoot] }).sessions.length, 0);
		const header = JSON.parse(readFileSync(sessionPath, "utf8").split(/\r?\n/)[0]);
		assert.equal(header.backgroundInstance.status, "archived");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("prefix-first parse finds inline-header lanes and rejects large non-background sessions", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-agent-hub-"));
	try {
		// Given
		const sessionsRoot = join(tmp, "sessions");
		const projectDir = join(sessionsRoot, "C-dev-repo");
		mkdirSync(projectDir, { recursive: true });

		// Background lane with backgroundInstance ON the header line (modern format):
		// must be found from the bounded prefix read alone.
		const lanePath = join(projectDir, "2026-06-23T000000_lane.jsonl");
		writeFileSync(
			lanePath,
			jsonLine({
				type: "session",
				version: 3,
				id: "lane-1",
				cwd: "C:\\dev\\repo",
				timestamp: "2026-06-23T10:00:00.000Z",
				backgroundInstance: { name: "inline-worker", status: "active", model: "gpt-5" },
			})
				// A large body must NOT need to be read to classify this lane.
				+ jsonLine({ type: "message", text: "x".repeat(2_000_000) }),
		);

		// Plain (non-background) session, also large: must be rejected without a
		// whole-file read.
		const plainPath = join(projectDir, "2026-06-23T010000_plain.jsonl");
		writeFileSync(
			plainPath,
			jsonLine({ type: "session", version: 3, id: "plain-1", cwd: "C:\\dev\\repo" })
				+ jsonLine({ type: "message", text: "y".repeat(2_000_000) }),
		);

		// When
		const dashboard = buildOhMyPiAgentHubDashboard({ sessionsRoots: [sessionsRoot] });

		// Then
		assert.equal(dashboard.sessions.length, 1);
		assert.equal(dashboard.sessions[0].name, "inline-worker");
		assert.equal(dashboard.sessions[0].sessionId, "lane-1");
		assert.equal(dashboard.sessions[0].model, "gpt-5");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
