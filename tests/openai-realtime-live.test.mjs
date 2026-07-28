import test from "node:test";
import { WebSocketServer } from "ws";
import { createServer } from "node:net";
import { once } from "node:events";

import assert from "node:assert/strict";
import {
	connectOpenAiRealtimeLive,
	DEFAULT_SPEECH_TO_SPEECH_URL,
	isOpenAiRealtimeLiveConfigured,
	mapRealtimeToolsToOpenAi,
	resolveOpenAiRealtimeConnectUrl,
	resamplePcm16Mono,
} from "../dist/openai-realtime-live.js";
import { buildRealtimeTools } from "../dist/realtime-gateway.js";
import { resolveLiveBackendKind, liveBackendSupportsResumption } from "../dist/live-backend.js";

async function waitFor(predicate, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timeout waiting for adapter event");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function startHandshakeServer() {
	const server = new WebSocketServer({ port: 0 });
	await once(server, "listening");
	const sockets = [];
	const messages = [];
	server.on("connection", (socket) => {
		sockets.push(socket);
		socket.send(JSON.stringify({ type: "session.created", session: { id: "sess_test" } }));
		socket.on("message", (raw) => {
			let message;
			try { message = JSON.parse(String(raw)); } catch { return; }
			messages.push(message);
			if (message.type === "session.update") {
				socket.send(JSON.stringify({ type: "session.updated", session: message.session || {} }));
			}
		});
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { server, sockets, messages, url: `ws://127.0.0.1:${address.port}/v1/realtime` };
}

test("resolveOpenAiRealtimeConnectUrl accepts full realtime URLs and bare hosts", () => {
	assert.equal(resolveOpenAiRealtimeConnectUrl({}), DEFAULT_SPEECH_TO_SPEECH_URL);
	assert.equal(DEFAULT_SPEECH_TO_SPEECH_URL, "ws://localhost:8765/v1/realtime");
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
test("official OpenAI URL carries a model and 16 kHz client PCM is resampled", () => {
	assert.equal(
		resolveOpenAiRealtimeConnectUrl({ PI_SPEAK_OPENAI_REALTIME_URL: "wss://api.openai.com/v1/realtime", PI_SPEAK_OPENAI_REALTIME_MODEL: "gpt-realtime-test" }),
		"wss://api.openai.com/v1/realtime?model=gpt-realtime-test",
	);
	const pcm16k = Buffer.alloc(320 * 2);
	assert.equal(resamplePcm16Mono(pcm16k, 16_000, 24_000).length, 480 * 2);
});

test("isOpenAiRealtimeLiveConfigured tracks explicit URL presence only", () => {
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

test("mapRealtimeToolsToOpenAi normalizes nested Gemini schema types", () => {
	const mapped = mapRealtimeToolsToOpenAi([{
		functionDeclarations: [{
			name: "nested",
			parameters: {
				type: "OBJECT",
				properties: {
					command: { type: "STRING" },
					items: { type: "ARRAY", items: { type: "NUMBER" } },
				},
				required: ["command"],
				anyOf: [{ type: "BOOLEAN" }],
			},
		}],
	}]);
	assert.deepEqual(mapped[0].parameters, {
		type: "object",
		properties: {
			command: { type: "string" },
			items: { type: "array", items: { type: "number" } },
		},
		required: ["command"],
		anyOf: [{ type: "boolean" }],
	});
});

test("OpenAI adapter waits for session.updated and finalizes assistant transcripts once", async () => {
	const mock = await startHandshakeServer();
	const outbound = [];
	let session;
	try {
		session = await connectOpenAiRealtimeLive(
			{ connectUrl: mock.url, inputTranscriptionModel: "test-transcribe" },
			{ systemInstruction: "test", tools: [] },
			{ onOutbound: (event) => outbound.push(event) },
		);
		await waitFor(() => outbound.some((event) => event.kind === "status" && event.status === "ready"));
		const ready = outbound.filter((event) => event.kind === "status" && event.status === "ready");
		assert.equal(ready.length, 1);
		assert.equal(ready[0].detail, "session.updated");
		const update = mock.messages.find((message) => message.type === "session.update");
		assert.equal(update.session.audio.input.format.rate, 24_000);
		assert.equal(update.session.audio.input.transcription.model, "test-transcribe");

		const socket = mock.sockets[0];
		assert.ok(socket);
		socket.send(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "hello" }));
		socket.send(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "hello" }));
		socket.send(JSON.stringify({ type: "response.done", response: { id: "resp_test" } }));
		await waitFor(() => outbound.some((event) => event.kind === "transcript" && event.final === true));
		const transcriptEvents = outbound.filter((event) => event.kind === "transcript");
		assert.deepEqual(transcriptEvents.map((event) => event.text), ["hello", ""]);
		assert.equal(transcriptEvents.filter((event) => event.final === true).length, 1);

		socket.send(JSON.stringify({ type: "error", error: { message: "provider rejected turn" } }));
		await waitFor(() => outbound.some((event) => event.kind === "error" && event.message === "provider rejected turn"));
		session.close();
		assert.equal(session.sendImage({ data: "AA==", mimeType: "image/jpeg" }), false);
		session = null;
	} finally {
		session?.close();
		for (const socket of mock.server.clients) socket.terminate();
		await new Promise((resolve) => mock.server.close(resolve));
	}
});

test("OpenAI adapter closes a socket when connect times out", async () => {
	const sockets = [];
	const server = createServer((socket) => sockets.push(socket));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		const startedAt = Date.now();
		await assert.rejects(
			connectOpenAiRealtimeLive(
				{ connectUrl: `ws://127.0.0.1:${address.port}/v1/realtime`, connectTimeoutMs: 20 },
				{},
				{ onOutbound: () => {} },
			),
			/timed out/,
		);
		assert.ok(Date.now() - startedAt < 500, "adapter should reject promptly at the configured timeout");
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("resolveLiveBackendKind defaults to HF speech-to-speech when an S2S URL is set", () => {
	assert.equal(resolveLiveBackendKind({}), "gemini");
	assert.equal(resolveLiveBackendKind({ PI_SPEAK_LIVE_BACKEND: "openai-realtime" }), "openai-realtime");
	assert.equal(resolveLiveBackendKind({ SPEECH_TO_SPEECH_URL: "ws://localhost:8765" }), "openai-realtime");
	assert.equal(resolveLiveBackendKind({ PI_SPEAK_S2S_URL: "s2s.example" }), "openai-realtime");
	assert.equal(resolveLiveBackendKind({ PI_SPEAK_OPENAI_REALTIME_URL: "wss://x/v1/realtime" }), "openai-realtime");
	// Explicit gemini always wins, even with an S2S URL configured.
	assert.equal(
		resolveLiveBackendKind({ PI_SPEAK_LIVE_BACKEND: "gemini", SPEECH_TO_SPEECH_URL: "ws://localhost:8765" }),
		"gemini",
	);
});


test("OpenAI-Realtime/HF does not advertise Gemini-style resumption", () => {
	assert.equal(liveBackendSupportsResumption("gemini"), true);
	assert.equal(liveBackendSupportsResumption("openai-realtime"), false);
});

test("reconnect policy keeps Gemini resumption exclusive to gemini kind", () => {
	const kind = resolveLiveBackendKind({ PI_SPEAK_LIVE_BACKEND: "hf" });
	assert.equal(kind, "openai-realtime");
	assert.equal(liveBackendSupportsResumption(kind), false);
});
