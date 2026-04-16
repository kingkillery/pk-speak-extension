import test from "node:test";
import assert from "node:assert/strict";
import {
	findSessionRouteConflict,
	getNumericRouteFamily,
	resolveSessionRoute,
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
