import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadSessionDashboard,
	projectDashboardLines,
	projectDashboardRow,
} from "../dist/ui/selectors.js";
import {
	getSessionRoutingStorePath,
	persistSessionRouting,
} from "../dist/session-routing-store.js";

let inkTestingLibrary;
try {
	inkTestingLibrary = await import("ink-testing-library");
} catch {
	inkTestingLibrary = undefined;
}

function withIsolatedStore(fn) {
	return async () => {
		const previousLocalAppData = process.env.LOCALAPPDATA;
		const previousAppData = process.env.APPDATA;
		const root = mkdtempSync(join(tmpdir(), "pi-speak-ui-dash-"));
		process.env.LOCALAPPDATA = root;
		process.env.APPDATA = root;
		try {
			await fn(root);
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			if (previousAppData === undefined) delete process.env.APPDATA;
			else process.env.APPDATA = previousAppData;
			rmSync(root, { recursive: true, force: true });
		}
	};
}

test(
	"current+busy only fixture: single current session, actively working",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Bugfix: "/sessions/bugfix.jsonl" },
			aliases: { One: "/sessions/bugfix.jsonl" },
		});

		const dashboard = loadSessionDashboard({
			runtimeSnapshots: [],
			currentSessionPath: "/sessions/bugfix.jsonl",
			currentSessionName: "Bugfix",
			currentBusy: true,
			currentReady: false,
		});

		assert.equal(dashboard.current, "Bugfix");
		assert.deepEqual(dashboard.ready, []);
		assert.equal(dashboard.storePath, getSessionRoutingStorePath());
		assert.equal(dashboard.sessions.length, 1);

		const [entry] = dashboard.sessions;
		assert.equal(entry.name, "Bugfix");
		assert.equal(entry.current, true);
		assert.equal(entry.ready, false);
		assert.equal(entry.activity, "busy");
		assert.deepEqual(entry.aliases, ["One"]);

		const row = projectDashboardRow(entry);
		assert.equal(row.marker, ">");
		assert.deepEqual(row.tags, ["current", "busy"]);

		const lines = projectDashboardLines(dashboard);
		assert.match(lines[0], /^pi-speak session manager/);
		assert.ok(lines[0].includes(`store: ${getSessionRoutingStorePath()}`));
		assert.ok(lines.some((line) => line === "Current: Bugfix"));
		assert.ok(lines.some((line) => line === "Ready:   none"));
		assert.ok(
			lines.some((line) => line.startsWith("> Bugfix") && line.includes("[current]") && line.includes("[busy]") && line.includes("aliases: One")),
			`expected bugfix row in lines: ${JSON.stringify(lines)}`,
		);
	}),
);

test(
	"saved-only fixture: sessions in store, no runtime snapshots",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: {
				Docs: "/sessions/docs.jsonl",
				Research: "/sessions/research.jsonl",
			},
			aliases: {
				Three: "/sessions/docs.jsonl",
			},
		});

		const dashboard = loadSessionDashboard({
			runtimeSnapshots: [],
		});

		assert.equal(dashboard.current, "none");
		assert.deepEqual(dashboard.ready, []);
		assert.equal(dashboard.sessions.length, 2);

		for (const entry of dashboard.sessions) {
			assert.equal(entry.current, false);
			assert.equal(entry.ready, false);
			assert.equal(entry.activity, "saved", `expected ${entry.name} to be saved`);
		}

		const byName = new Map(dashboard.sessions.map((entry) => [entry.name, entry]));
		assert.deepEqual(byName.get("Docs").aliases, ["Three"]);
		assert.deepEqual(byName.get("Research").aliases, []);

		const lines = projectDashboardLines(dashboard);
		assert.ok(lines.some((line) => line === "Current: none"));
		assert.ok(lines.some((line) => line === "Ready:   none"));
		assert.ok(lines.some((line) => line.includes("Docs") && line.includes("[saved]")));
		assert.ok(lines.some((line) => line.includes("Research") && line.includes("[saved]")));
		for (const line of lines) {
			assert.ok(!line.includes("[busy]"), `no busy tag expected: ${line}`);
			assert.ok(!line.includes("[current]"), `no current tag expected: ${line}`);
		}
	}),
);

test(
	"ready+busy fixture: current busy, other ready, third saved",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: {
				Voice: "/sessions/voice.jsonl",
				"voice-bugfix": "/sessions/bugfix.jsonl",
				"voice-docs": "/sessions/docs.jsonl",
			},
			aliases: {
				one: "/sessions/voice.jsonl",
				two: "/sessions/bugfix.jsonl",
				three: "/sessions/docs.jsonl",
			},
		});

		const dashboard = loadSessionDashboard({
			runtimeSnapshots: [
				{
					sessionPath: "/sessions/voice.jsonl",
					sessionName: "Voice",
					phase: "llm",
					waitingForAttention: false,
					aliases: [],
				},
				{
					sessionPath: "/sessions/bugfix.jsonl",
					sessionName: "voice-bugfix",
					phase: "ready",
					waitingForAttention: true,
					aliases: [],
				},
			],
			currentSessionPath: "/sessions/voice.jsonl",
			currentSessionName: "Voice",
			currentBusy: true,
			currentReady: false,
		});

		assert.equal(dashboard.current, "Voice");
		assert.deepEqual(dashboard.ready, ["voice-bugfix"]);
		assert.equal(dashboard.sessions.length, 3);

		const byName = new Map(dashboard.sessions.map((entry) => [entry.name, entry]));
		const voice = byName.get("Voice");
		assert.equal(voice.current, true);
		assert.equal(voice.ready, false);
		assert.equal(voice.activity, "busy");
		assert.deepEqual(voice.aliases, ["one"]);

		const bugfix = byName.get("voice-bugfix");
		assert.equal(bugfix.current, false);
		assert.equal(bugfix.ready, true);
		assert.equal(bugfix.activity, "idle");
		assert.deepEqual(bugfix.aliases, ["two"]);

		const docs = byName.get("voice-docs");
		assert.equal(docs.current, false);
		assert.equal(docs.ready, false);
		assert.equal(docs.activity, "saved");
		assert.deepEqual(docs.aliases, ["three"]);

		assert.equal(dashboard.sessions[0].name, "Voice", "current session sorted first");
		assert.equal(dashboard.sessions[1].name, "voice-bugfix", "ready session next");

		const lines = projectDashboardLines(dashboard);
		assert.ok(lines.some((line) => line === "Current: Voice"));
		assert.ok(lines.some((line) => line === "Ready:   voice-bugfix"));
		const voiceRow = lines.find((line) => line.includes("Voice") && line.trim().startsWith(">"));
		assert.ok(voiceRow, `expected focused voice row: ${JSON.stringify(lines)}`);
		assert.ok(voiceRow.includes("[current]"));
		assert.ok(voiceRow.includes("[busy]"));
		assert.ok(voiceRow.includes("aliases: one"));
		const bugfixRow = lines.find(
			(line) => line.includes("voice-bugfix") && !line.startsWith("Ready:"),
		);
		assert.ok(bugfixRow, `expected bugfix session row: ${JSON.stringify(lines)}`);
		assert.ok(bugfixRow.includes("[ready]"));
		assert.ok(bugfixRow.includes("[idle]"));
		assert.ok(bugfixRow.includes("aliases: two"));
	}),
);

test("ink-testing-library availability noted", () => {
	if (inkTestingLibrary) {
		assert.ok(
			typeof inkTestingLibrary.render === "function",
			"ink-testing-library imported but render() unavailable",
		);
	} else {
		assert.ok(true, "ink-testing-library not installed; snapshot-only fallback is in effect");
	}
});
