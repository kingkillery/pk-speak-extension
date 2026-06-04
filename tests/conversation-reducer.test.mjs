import test from "node:test";
import assert from "node:assert/strict";
import { reduceConversationTurn } from "../dist/conversation-reducer.js";

async function withEnv(patch, run) {
	const previous = {};
	for (const key of Object.keys(patch)) {
		previous[key] = process.env[key];
		const value = patch[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("OpenAI reducer mode falls back to heuristic when no router key is configured", async () => {
	await withEnv({
		PI_SPEAK_REDUCER_MODE: "openai",
		PI_SPEAK_ROUTER_OPENAI_KEY: undefined,
		OPENAI_API_KEY: undefined,
	}, async () => {
		const result = await reduceConversationTurn("inspect the current project status");
		assert.equal(result.summary.engine, "heuristic");
		assert.equal(result.dispatch, true);
		assert.deepEqual(result.summary.actionItems, ["inspect the current project status"]);
	});
});

test("voice reducer strips wake residue, filler, and adjacent repeated words", async () => {
	const result = await reduceConversationTurn("um okay hey pi please fix fix the Android session dashboard wiring", {
		source: "http-voice",
	});
	assert.equal(result.dispatch, true);
	assert.deepEqual(result.summary.actionItems, ["fix the Android session dashboard wiring"]);
	assert.match(result.summary.discarded.join(" "), /hey pi/i);
	assert.match(result.promptForAgent, /fix the Android session dashboard wiring/);
});

test("voice reducer refuses pure filler noise", async () => {
	const result = await reduceConversationTurn("um okay hmm never mind", {
		source: "telegram-voice",
	});
	assert.equal(result.dispatch, false);
	assert.equal(result.summary.actionItems.length, 0);
	assert.match(result.replyText, /concrete action/i);
});

test("text reducer leaves typed text unsanitized", async () => {
	const result = await reduceConversationTurn("okay please check current status", {
		source: "http-text",
	});
	assert.equal(result.dispatch, true);
	assert.deepEqual(result.summary.actionItems, ["okay please check current status"]);
});

test("OpenAI-compatible reducer tries configured router models in order", async () => {
	const previousFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		calls.push({
			model: body.model,
			user: body.messages.find((message) => message.role === "user")?.content,
			referer: options.headers["HTTP-Referer"],
			title: options.headers["X-Title"],
		});
		if (body.model === "first-router") {
			return {
				ok: false,
				status: 503,
				json: async () => ({}),
			};
		}
		return {
			ok: true,
			json: async () => ({
				choices: [{
					message: {
						content: JSON.stringify({
							goal: "Inspect sessions",
							actionItems: ["inspect sessions"],
							constraints: [],
							deferredReminders: [],
							doNotDo: [],
							unknowns: [],
							shouldDispatch: true,
							confidence: 0.92,
						}),
					},
				}],
			}),
		};
	};
	try {
		await withEnv({
			PI_SPEAK_REDUCER_MODE: "openai",
			PI_SPEAK_ROUTER_OPENAI_KEY: "router-key",
			OPENAI_API_KEY: undefined,
			PI_SPEAK_OPENAI_BASE_URL: "https://openrouter.ai/api/v1/",
			PI_SPEAK_ROUTER_MODELS: "first-router, second-router",
			PI_SPEAK_HTTP_REFERER: "https://example.test/pi-speak",
			PI_SPEAK_APP_TITLE: "Pi Speak Test",
		}, async () => {
			const result = await reduceConversationTurn("um okay pk please inspect sessions", {
				source: "http-voice",
			});
			assert.equal(result.summary.engine, "openai");
			assert.equal(result.dispatch, true);
			assert.deepEqual(result.summary.actionItems, ["inspect sessions"]);
			assert.deepEqual(calls.map((call) => call.model), ["first-router", "second-router"]);
			assert.equal(calls[1].user, "inspect sessions");
			assert.equal(calls[1].referer, "https://example.test/pi-speak");
			assert.equal(calls[1].title, "Pi Speak Test");
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});

// These tests exercise the deterministic heuristic path only (mode: "heuristic"),
// so they never reach out to Gemini and stay fully offline/reproducible. An
// explicit minConfidence keeps results independent of the ambient env config.
const HEURISTIC = { mode: "heuristic", minConfidence: 0.45 };

test("a clear imperative produces an action item and dispatches", async () => {
	const result = await reduceConversationTurn("Please add a logout button to the navbar.", HEURISTIC);
	assert.equal(result.summary.engine, "heuristic");
	assert.ok(result.summary.actionItems.length >= 1, "expected at least one action item");
	assert.ok(result.summary.confidence > 0.45, `expected high confidence, got ${result.summary.confidence}`);
	assert.equal(result.dispatch, true);
	assert.equal(result.summary.shouldDispatch, true);
	// When we dispatch, there is no clarifying reply to speak back.
	assert.equal(result.replyText, "");
});

test("empty input does not dispatch and asks for a concrete action", async () => {
	const result = await reduceConversationTurn("   ", HEURISTIC);
	assert.equal(result.dispatch, false);
	assert.equal(result.summary.shouldDispatch, false);
	assert.equal(result.summary.actionItems.length, 0);
	assert.ok(result.summary.confidence < 0.2, "empty text should have very low confidence");
	assert.ok(result.replyText.length > 0, "expected a spoken clarifying reply");
	assert.equal(result.summary.clarifyingQuestion, result.replyText);
});

test("chit-chat without an action item does not dispatch", async () => {
	const result = await reduceConversationTurn("Hey, thanks, that sounds good.", HEURISTIC);
	assert.equal(result.dispatch, false);
	assert.equal(result.summary.actionItems.length, 0);
	assert.ok(result.replyText.length > 0);
});

test("negations are captured as constraints and do-not-do items", async () => {
	const result = await reduceConversationTurn(
		"Refactor the parser but don't touch the public API.",
		HEURISTIC,
	);
	assert.ok(result.summary.actionItems.length >= 1, "refactor should be an action item");
	assert.ok(
		result.summary.constraints.some((c) => /public api/i.test(c)),
		`expected a constraint mentioning the public API, got ${JSON.stringify(result.summary.constraints)}`,
	);
	assert.ok(
		result.summary.doNotDo.some((d) => /don't|do not/i.test(d)),
		`expected a do-not-do entry, got ${JSON.stringify(result.summary.doNotDo)}`,
	);
});

test("greetings are discarded while the real instruction survives", async () => {
	const result = await reduceConversationTurn("Hey. Thanks. Add a logout button.", HEURISTIC);
	assert.ok(
		result.summary.discarded.some((d) => /hey|thanks/i.test(d)),
		`expected greetings to be discarded, got ${JSON.stringify(result.summary.discarded)}`,
	);
	assert.ok(
		result.summary.actionItems.some((a) => /logout button/i.test(a)),
		"the actionable sentence should not be discarded",
	);
});

test("deferred phrasing is surfaced as a reminder", async () => {
	const result = await reduceConversationTurn("Remind me to update the changelog later.", HEURISTIC);
	assert.ok(
		result.summary.deferredReminders.length >= 1,
		`expected a deferred reminder, got ${JSON.stringify(result.summary.deferredReminders)}`,
	);
});

test("uncertainty is captured as an unknown", async () => {
	const result = await reduceConversationTurn("I'm not sure how the auth flow works.", HEURISTIC);
	assert.ok(
		result.summary.unknowns.length >= 1,
		`expected an unknown to be recorded, got ${JSON.stringify(result.summary.unknowns)}`,
	);
});

test("repeated instructions are de-duplicated in the summary", async () => {
	const result = await reduceConversationTurn("Add a button. Add a button.", HEURISTIC);
	assert.equal(result.summary.actionItems.length, 1, "identical action items should collapse to one");
});

test("the agent prompt always carries the goal and original transcript", async () => {
	const transcript = "Fix the flaky login test.";
	const result = await reduceConversationTurn(transcript, HEURISTIC);
	assert.match(result.promptForAgent, /Goal:/);
	assert.match(result.promptForAgent, /Original transcript:/);
	assert.ok(result.promptForAgent.includes(transcript), "prompt should embed the raw transcript");
});

test("confidence is always clamped to the 0..1 range", async () => {
	for (const text of ["", "go", "Please add, fix, build, and ship the whole thing right now."]) {
		const result = await reduceConversationTurn(text, HEURISTIC);
		assert.ok(result.summary.confidence >= 0 && result.summary.confidence <= 1, `confidence out of range for ${JSON.stringify(text)}: ${result.summary.confidence}`);
	}
});

test("reducerMs is reported as a non-negative number", async () => {
	const result = await reduceConversationTurn("Run the tests.", HEURISTIC);
	assert.equal(typeof result.reducerMs, "number");
	assert.ok(result.reducerMs >= 0);
});
