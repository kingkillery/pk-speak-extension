import test from "node:test";
import assert from "node:assert/strict";
import {
	isOpenAiRealtimeLiveConfigured,
	mapRealtimeToolsToOpenAi,
	resolveOpenAiRealtimeConnectUrl,
} from "../dist/openai-realtime-live.js";
import { buildRealtimeTools } from "../dist/realtime-gateway.js";
import { resolveLiveBackendKind } from "../dist/live-backend.js";

test("resolveOpenAiRealtimeConnectUrl accepts full realtime URLs and bare hosts", () => {
	assert.equal(resolveOpenAiRealtimeConnectUrl({}), "");
	assert.equal(
		resolveOpenAiRealtimeConnectUrl({ PI_SPEAK_OPENAI_REALTIME_URL: "wss://example.test/v1/realtime?session_token=abc" }),
		"wss://example.test/v1/realtime?session_token=abc",
	);
	assert.equal(
		resolveOpenAiRealtimeConnectUrl({ SPEECH_TO_SPEECH_URL: "https://s2s.example" }),
		"wss://s2s.example/v1/realtime",
	);
	assert.equal(
		resolveOpenAiRealtimeConnectUrl({ PI_SPEAK_S2S_URL: "s2s.example:8080" }),
		"wss://s2s.example:8080/v1/realtime",
	);
});

test("isOpenAiRealtimeLiveConfigured tracks URL presence", () => {
	assert.equal(isOpenAiRealtimeLiveConfigured({}), false);
	assert.equal(isOpenAiRealtimeLiveConfigured({ SPEECH_TO_SPEECH_URL: "wss://x/v1/realtime" }), true);
});

test("mapRealtimeToolsToOpenAi converts Gemini functionDeclarations", () => {
	const tools = buildRealtimeTools(false);
	const mapped = mapRealtimeToolsToOpenAi(tools);
	const names = mapped.map((t) => t.name);
	assert.ok(names.includes("web_search"));
	assert.ok(names.includes("camera_snapshot"));
	assert.ok(names.includes("execute_terminal_command"));
	assert.equal(mapped[0].type, "function");
	assert.ok(mapped[0].parameters);
});

test("resolveLiveBackendKind still defaults to gemini", () => {
	assert.equal(resolveLiveBackendKind({}), "gemini");
	assert.equal(resolveLiveBackendKind({ PI_SPEAK_LIVE_BACKEND: "openai-realtime" }), "openai-realtime");
});
