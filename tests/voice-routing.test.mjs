import test from "node:test";
import assert from "node:assert/strict";
import {
	findSessionRouteConflict,
	getNumericRouteFamily,
	isSpeechInterruptCommand,
	resolveSessionRoute,
	resolveSessionTarget,
} from "../dist/voice-routing.js";

test("numeric route families keep one and two distinct", () => {
	assert.equal(getNumericRouteFamily("one"), "1");
	assert.equal(getNumericRouteFamily("1"), "1");
	assert.equal(getNumericRouteFamily("two"), "2");
	assert.equal(getNumericRouteFamily("2"), "2");
	assert.equal(getNumericRouteFamily("to"), undefined);
	assert.equal(getNumericRouteFamily("to google"), undefined);
});

test("session routing resolves compact numeric aliases to the matching family", () => {
	const sessions = {
		one: "/sessions/one.jsonl",
		2: "/sessions/two.jsonl",
	};

	assert.deepEqual(resolveSessionRoute("1", sessions), {
		sessionName: "one",
		sessionPath: "/sessions/one.jsonl",
		matchedBy: "numeric-family",
	});

	assert.deepEqual(resolveSessionRoute("two", sessions), {
		sessionName: "2",
		sessionPath: "/sessions/two.jsonl",
		matchedBy: "numeric-family",
	});
});

test("multiword routes stay literal instead of collapsing into numeric families", () => {
	const sessions = {
		"To Google": "/sessions/google.jsonl",
		2: "/sessions/two.jsonl",
	};

	assert.deepEqual(resolveSessionRoute("to google", sessions), {
		sessionName: "To Google",
		sessionPath: "/sessions/google.jsonl",
		matchedBy: "exact",
	});

	assert.equal(resolveSessionRoute("to", sessions), undefined);
});

test("homophones of one and two never collapse into a numeric family", () => {
	for (const homophone of ["won", "wun", "wan", "to", "too", "tu", "tew", "tue"]) {
		assert.equal(
			getNumericRouteFamily(homophone),
			undefined,
			`expected "${homophone}" to not match any numeric family`,
		);
	}
});

test("resolveSessionTarget prefers exact name, then alias, then numeric family", () => {
	const sessions = { research: "/sessions/research.jsonl", one: "/sessions/one.jsonl" };
	const aliases = { primary: "/sessions/research.jsonl", "2": "/sessions/two.jsonl" };

	assert.deepEqual(resolveSessionTarget("research", sessions, aliases), {
		sessionPath: "/sessions/research.jsonl",
		matchedLabel: "research",
		matchedBy: "name",
	});

	assert.deepEqual(resolveSessionTarget("primary", sessions, aliases), {
		sessionPath: "/sessions/research.jsonl",
		matchedLabel: "primary",
		matchedBy: "alias",
	});

	assert.deepEqual(resolveSessionTarget("two", sessions, aliases), {
		sessionPath: "/sessions/two.jsonl",
		matchedLabel: "2",
		matchedBy: "alias",
	});

	assert.equal(resolveSessionTarget("unknown", sessions, aliases), undefined);
});

test("isSpeechInterruptCommand recognises canonical phrases and shrugs at others", () => {
	for (const phrase of ["stop", "stop speaking", "be quiet", "shut up", "shush", "quiet"]) {
		assert.equal(isSpeechInterruptCommand(phrase), true, `expected "${phrase}" to interrupt`);
	}
	for (const phrase of ["", "stop the build", "please be quiet for a sec", "shush the dog"]) {
		assert.equal(isSpeechInterruptCommand(phrase), false, `expected "${phrase}" not to interrupt`);
	}
});

test("naming rejects conflicting numeric voice families across different sessions", () => {
	const sessions = {
		one: "/sessions/one.jsonl",
		research: "/sessions/research.jsonl",
	};

	assert.deepEqual(findSessionRouteConflict("1", sessions), {
		sessionName: "one",
		sessionPath: "/sessions/one.jsonl",
		reason: "numeric-family",
		family: "1",
	});

	assert.equal(findSessionRouteConflict("1", sessions, "/sessions/one.jsonl"), undefined);
});
