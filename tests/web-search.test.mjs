import test from "node:test";
import assert from "node:assert/strict";
import {
	formatWebSearchForSpeech,
	getSerperApiKey,
	isWebSearchConfigured,
	runWebSearch,
} from "../dist/web-search.js";
import { resolveLiveBackendKind, OPENAI_REALTIME_CLIENT_EVENTS } from "../dist/live-backend.js";

test("getSerperApiKey prefers PI_SPEAK_SERPER_API_KEY over SERPER_API_KEY", () => {
	assert.equal(getSerperApiKey({ PI_SPEAK_SERPER_API_KEY: "a", SERPER_API_KEY: "b" }), "a");
	assert.equal(getSerperApiKey({ SERPER_API_KEY: "b" }), "b");
	assert.equal(getSerperApiKey({}), "");
});

test("isWebSearchConfigured is false without a key", () => {
	assert.equal(isWebSearchConfigured({}), false);
	assert.equal(isWebSearchConfigured({ SERPER_API_KEY: "x" }), true);
});

test("runWebSearch rejects empty query and missing key without network", async () => {
	const empty = await runWebSearch("   ", { apiKey: "k" });
	assert.equal(empty.ok, false);
	const noKey = await runWebSearch("hello", { apiKey: "" });
	assert.equal(noKey.ok, false);
	assert.match(noKey.error, /not configured/i);
});

test("runWebSearch maps Serper organic results via injected fetch", async () => {
	const fetchImpl = async () => ({
		ok: true,
		json: async () => ({
			answerBox: { answer: "42" },
			organic: [
				{ title: "One", link: "https://a.example", snippet: "first" },
				{ title: "Two", link: "https://b.example", snippet: "second" },
			],
		}),
	});
	const result = await runWebSearch("meaning of life", { apiKey: "test-key", fetchImpl });
	assert.equal(result.ok, true);
	assert.equal(result.answer, "42");
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].title, "One");
	const speech = formatWebSearchForSpeech(result);
	assert.match(speech, /Answer box: 42/);
	assert.match(speech, /1\. One/);
});

test("resolveLiveBackendKind accepts HF/S2S aliases and URL-based default", () => {
	assert.equal(resolveLiveBackendKind({}), "gemini");
	assert.equal(resolveLiveBackendKind({ PI_SPEAK_LIVE_BACKEND: "hf" }), "openai-realtime");
	assert.equal(resolveLiveBackendKind({ PI_SPEAK_LIVE_BACKEND: "openai-realtime" }), "openai-realtime");
	assert.equal(resolveLiveBackendKind({ PI_SPEAK_LIVE_BACKEND: "gemini" }), "gemini");
	assert.equal(resolveLiveBackendKind({ SPEECH_TO_SPEECH_URL: "ws://localhost:8765" }), "openai-realtime");
});

test("OpenAI Realtime event name constants stay aligned with HF methodology", () => {
	assert.ok(OPENAI_REALTIME_CLIENT_EVENTS.includes("input_audio_buffer.append"));
	assert.ok(OPENAI_REALTIME_CLIENT_EVENTS.includes("session.update"));
});
