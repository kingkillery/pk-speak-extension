import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCompactRouteSlots,
	buildSessionDashboard,
	clearWakeAlias,
	describeSessionRoutingStore,
	findSessionRegistryKey,
	findWakeAliasKey,
	formatCompactRouteSlots,
	enrichDashboardWithWorkspaces,
	formatSessionManagerSummary,
	formatSessionRoutingList,
	removeSessionRoutingForPath,
	setNamedSession,
	setWakeAlias,
} from "../dist/session-routing.js";

test("setNamedSession rejects duplicate names that point to another session", () => {
	const result = setNamedSession(
		{
			Bugfix: "/sessions/a.jsonl",
		},
		"bugfix",
		"/sessions/b.jsonl",
	);
	assert.deepEqual(result, {
		ok: false,
		error: 'Session name "Bugfix" already points to another session. Choose a different name.',
	});
});

test("setNamedSession replaces stale names for the same session path", () => {
	const result = setNamedSession(
		{
			Old: "/sessions/a.jsonl",
			Other: "/sessions/b.jsonl",
		},
		"Active Work",
		"/sessions/a.jsonl",
	);
	assert.deepEqual(result, {
		ok: true,
		name: "Active Work",
		sessions: {
			Other: "/sessions/b.jsonl",
			"Active Work": "/sessions/a.jsonl",
		},
	});
});

test("findSessionRegistryKey and findWakeAliasKey use normalized matching", () => {
	assert.equal(findSessionRegistryKey("to google", { "To Google": "/sessions/a.jsonl" }), "To Google");
	assert.equal(findWakeAliasKey("one", { One: "/sessions/a.jsonl" }), "One");
});

test("setWakeAlias replaces casing variants without duplicating alias entries", () => {
	const result = setWakeAlias(
		{
			One: "/sessions/a.jsonl",
		},
		"one",
		"/sessions/b.jsonl",
	);
	assert.deepEqual(result, {
		alias: "one",
		replacedAlias: "One",
		aliases: {
			one: "/sessions/b.jsonl",
		},
	});
});

test("clearWakeAlias is case-insensitive", () => {
	const result = clearWakeAlias(
		{
			"To Google": "/sessions/google.jsonl",
		},
		"to google",
	);
	assert.deepEqual(result, {
		ok: true,
		alias: "To Google",
		aliases: {},
	});
});

test("removeSessionRoutingForPath removes saved names and aliases for a session path", () => {
	const result = removeSessionRoutingForPath(
		{
			Bugfix: "/sessions/bugfix.jsonl",
			Research: "/sessions/research.jsonl",
		},
		{
			One: "/sessions/bugfix.jsonl",
			Two: "/sessions/research.jsonl",
		},
		"/sessions/bugfix.jsonl",
	);
	assert.deepEqual(result, {
		sessions: {
			Research: "/sessions/research.jsonl",
		},
		aliases: {
			Two: "/sessions/research.jsonl",
		},
		removedNames: ["Bugfix"],
		removedAliases: ["One"],
	});
});

test("formatSessionManagerSummary shows current, ready, and alias state inline", () => {
	const summary = formatSessionManagerSummary({
		sessions: {
			Bugfix: "/sessions/bugfix.jsonl",
			Research: "/sessions/research.jsonl",
		},
		aliases: {
			One: "/sessions/bugfix.jsonl",
		},
		runtimeSnapshots: [
			{
				sessionPath: "/sessions/research.jsonl",
				sessionName: "Research",
				phase: "llm",
				waitingForAttention: true,
				aliases: [],
			},
		],
		currentSessionPath: "/sessions/bugfix.jsonl",
		currentSessionName: "Bugfix",
		currentBusy: false,
		currentReady: false,
		storePath: "/tmp/session-routing.json",
	});
	assert.match(summary, /Current: Bugfix/);
	assert.match(summary, /Ready: Research/);
	assert.match(summary, /Store: \/tmp\/session-routing\.json/);
	assert.match(summary, /Slots: 1 → Bugfix, 2 → none/);
	assert.match(summary, /- Bugfix \[current\] \[idle\]/);
	assert.match(summary, /aliases: One/);
	assert.match(summary, /- Research \[ready\] \[busy\]/);
	assert.match(summary, /Tip: use \/sess slots/i);
});

test("formatSessionRoutingList summarizes sessions and aliases", () => {
	assert.equal(
		formatSessionRoutingList({
			sessions: {
				Bugfix: "/sessions/bugfix.jsonl",
			},
			aliases: {
				One: "/sessions/bugfix.jsonl",
			},
		}),
		"Sessions: Bugfix. Wake aliases: One → Bugfix",
	);
});

test("buildSessionDashboard resolves busy/idle/saved activity and ready state per spec", () => {
	const dashboard = buildSessionDashboard({
		sessions: {
			Bugfix: "/sessions/bugfix.jsonl",
			Research: "/sessions/research.jsonl",
			Docs: "/sessions/docs.jsonl",
		},
		aliases: {
			One: "/sessions/bugfix.jsonl",
			Two: "/sessions/research.jsonl",
		},
		workingDirectories: {
			"/sessions/bugfix.jsonl": "/work/bugfix",
			"/sessions/research.jsonl": "/work/research",
		},
		runtimeSnapshots: [
			{
				sessionPath: "/sessions/research.jsonl",
				sessionName: "Research",
				phase: "llm",
				waitingForAttention: true,
				aliases: [],
			},
			{
				sessionPath: "/sessions/bugfix.jsonl",
				sessionName: "Bugfix",
				phase: "ready",
				waitingForAttention: false,
				aliases: [],
			},
		],
		currentSessionPath: "/sessions/bugfix.jsonl",
		currentSessionName: "Bugfix",
		currentBusy: false,
		currentReady: false,
		storePath: "/tmp/session-routing.json",
	});

	assert.equal(dashboard.current, "Bugfix");
	assert.deepEqual(dashboard.ready, ["Research"]);
	assert.equal(dashboard.storePath, "/tmp/session-routing.json");

	const byName = new Map(dashboard.sessions.map((entry) => [entry.name, entry]));

	const bugfix = byName.get("Bugfix");
	assert.ok(bugfix, "Bugfix entry present");
	assert.equal(bugfix.current, true);
	assert.equal(bugfix.isCurrent, true);
	assert.equal(bugfix.ready, false);
	assert.equal(bugfix.activity, "idle");
	assert.equal(bugfix.path, "/sessions/bugfix.jsonl");
	assert.equal(bugfix.workingDirectory, "/work/bugfix");
	assert.equal(bugfix.cwd, "/work/bugfix");
	assert.deepEqual(bugfix.aliases, ["One"]);

	const research = byName.get("Research");
	assert.ok(research, "Research entry present");
	assert.equal(research.current, false);
	assert.equal(research.workingDirectory, "/work/research");
	assert.equal(research.ready, true);
	assert.equal(research.activity, "busy");
	assert.deepEqual(research.aliases, ["Two"]);

	const docs = byName.get("Docs");
	assert.ok(docs, "Docs entry present");
	assert.equal(docs.current, false);
	assert.equal(docs.ready, false);
	assert.equal(docs.activity, "saved");
	assert.deepEqual(docs.aliases, []);

	assert.equal(dashboard.sessions[0].name, "Bugfix", "current session sorted first");
});

test("buildSessionDashboard surfaces an unnamed current session and empties state", () => {
	const emptyDashboard = buildSessionDashboard({
		sessions: {},
		aliases: {},
	});
	assert.equal(emptyDashboard.current, "none");
	assert.deepEqual(emptyDashboard.ready, []);
	assert.deepEqual(emptyDashboard.sessions, []);

	const unnamedDashboard = buildSessionDashboard({
		sessions: {},
		aliases: {},
		currentSessionPath: "/sessions/anon.jsonl",
		currentBusy: true,
		currentReady: true,
	});
	assert.equal(unnamedDashboard.current, "(unnamed current session)");
	assert.deepEqual(unnamedDashboard.ready, ["(unnamed current session)"]);
	assert.equal(unnamedDashboard.sessions.length, 1);
	assert.equal(unnamedDashboard.sessions[0].activity, "busy");
	assert.equal(unnamedDashboard.sessions[0].ready, true);
	assert.equal(unnamedDashboard.sessions[0].current, true);
});

test("formatSessionManagerSummary output matches buildSessionDashboard text projection", () => {
	const options = {
		sessions: {
			Bugfix: "/sessions/bugfix.jsonl",
			Research: "/sessions/research.jsonl",
		},
		aliases: {
			One: "/sessions/bugfix.jsonl",
		},
		runtimeSnapshots: [
			{
				sessionPath: "/sessions/research.jsonl",
				sessionName: "Research",
				phase: "llm",
				waitingForAttention: true,
				aliases: [],
			},
		],
		currentSessionPath: "/sessions/bugfix.jsonl",
		currentSessionName: "Bugfix",
		currentBusy: false,
		currentReady: false,
		storePath: "/tmp/session-routing.json",
	};
	const summary = formatSessionManagerSummary(options);
	const dashboard = buildSessionDashboard(options);
	assert.match(summary, new RegExp(`Current: ${dashboard.current}`));
	assert.match(summary, new RegExp(`Ready: ${dashboard.ready.join(", ")}`));
	for (const entry of dashboard.sessions) {
		assert.ok(summary.includes(`- ${entry.name}`), `summary includes entry ${entry.name}`);
		assert.ok(summary.includes(`[${entry.activity}]`), `summary includes activity ${entry.activity}`);
	}
});

test("buildCompactRouteSlots and formatCompactRouteSlots summarize PK1/PK2 lanes", () => {
	const slots = buildCompactRouteSlots({
		sessions: {
			Bugfix: "/sessions/bugfix.jsonl",
			Research: "/sessions/research.jsonl",
		},
		aliases: {
			one: "/sessions/bugfix.jsonl",
			two: "/sessions/research.jsonl",
		},
	});
	assert.deepEqual(slots, [
		{
			family: "1",
			sessionPath: "/sessions/bugfix.jsonl",
			sessionName: "Bugfix",
			labels: ["one"],
			status: "mapped",
		},
		{
			family: "2",
			sessionPath: "/sessions/research.jsonl",
			sessionName: "Research",
			labels: ["two"],
			status: "mapped",
		},
	]);
	const text = formatCompactRouteSlots({
		sessions: {
			Bugfix: "/sessions/bugfix.jsonl",
			Research: "/sessions/research.jsonl",
		},
		aliases: {
			one: "/sessions/bugfix.jsonl",
			two: "/sessions/research.jsonl",
		},
	});
	assert.match(text, /Compact routes/);
	assert.match(text, /- 1: Bugfix via one/i);
	assert.match(text, /- 2: Research via two/i);
});


test("describeSessionRoutingStore includes store path", () => {
	assert.equal(
		describeSessionRoutingStore("/tmp/session-routing.json", {
			sessions: {},
			aliases: {},
		}),
		"Sessions: none. Wake aliases: none. Store: /tmp/session-routing.json",
	);
});

test("enrichDashboardWithWorkspaces hides an archived session despite path spelling differences", () => {
	// The dashboard scanner emits one spelling; the archive request stored another
	// equivalent spelling. The archived check must normalize both, or a session the
	// user archived stays visible (and the codex/claude track-and-hide breaks).
	const dashboard = {
		sessions: [
			{ sessionPath: "/sessions/proj/a.jsonl", lastActivity: Date.now() },
			{ sessionPath: "/sessions/proj/b.jsonl", lastActivity: Date.now() },
		],
	};
	const enriched = enrichDashboardWithWorkspaces(dashboard, {
		// Equivalent but differently-spelled path for a.jsonl.
		archivedPaths: ["/sessions/proj/sub/../a.jsonl"],
	});
	const visiblePaths = enriched.sessions.map((s) => s.sessionPath);
	assert.deepEqual(visiblePaths, ["/sessions/proj/b.jsonl"], "archived a.jsonl is hidden despite the ../ spelling");
});
