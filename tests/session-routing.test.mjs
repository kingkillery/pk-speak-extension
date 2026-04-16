import test from "node:test";
import assert from "node:assert/strict";
import {
	clearWakeAlias,
	describeSessionRoutingStore,
	findSessionRegistryKey,
	findWakeAliasKey,
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
	assert.match(summary, /- Bugfix \[current\] \[idle\]/);
	assert.match(summary, /aliases: One/);
	assert.match(summary, /- Research \[ready\] \[busy\]/);
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

test("describeSessionRoutingStore includes store path", () => {
	assert.equal(
		describeSessionRoutingStore("/tmp/session-routing.json", {
			sessions: {},
			aliases: {},
		}),
		"Sessions: none. Wake aliases: none. Store: /tmp/session-routing.json",
	);
});
