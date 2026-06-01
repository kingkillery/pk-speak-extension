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
