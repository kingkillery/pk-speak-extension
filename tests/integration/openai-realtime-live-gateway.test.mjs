import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { startMockOpenAiRealtimeServer } from "./mock-openai-realtime-server.mjs";
import { connectOpenAiRealtimeLive } from "../../dist/openai-realtime-live.js";
import { handleRealtimeGateway } from "../../dist/realtime-gateway.js";

/**
 * Runtime-seam test for the OpenAI-Realtime adapter (public connect helper).
 * Full ControlServer+/v1/live matrix is covered elsewhere for Gemini simulated;
 * this guards the OpenAI adapter path that pure URL tests cannot.
 */
test("OpenAI Realtime adapter: session ready, audio out, tool call round-trip", async () => {
	const mock = await startMockOpenAiRealtimeServer({ echoAudio: true, emitToolCall: true, toolName: "get_session_info" });
	const outbound = [];
	try {
		const session = await connectOpenAiRealtimeLive(
			{ connectUrl: mock.url },
			{ systemInstruction: "test", tools: [] },
			{
				onOutbound: (event) => outbound.push(event),
			},
		);

		// Wait for session.created → ready
		await waitFor(() => outbound.some((e) => e.kind === "status" && e.status === "ready"), 3000);

		session.sendAudio({ pcm: Buffer.alloc(320), sampleRate: 16000 });
		await waitFor(() => outbound.some((e) => e.kind === "audio"), 3000);

		// Trigger tool call via response.create (mock emits function_call on response.create)
		// Access through sendText which ends with response.create
		session.sendText("status?");
		// Also send response.create by interrupting then... mock emits tool on response.create from sendText
		await waitFor(() => outbound.some((e) => e.kind === "tool_call"), 3000);

		const tool = outbound.find((e) => e.kind === "tool_call");
		assert.ok(tool);
		assert.equal(tool.name, "get_session_info");
		session.sendToolResult(tool.id, tool.name, JSON.stringify({ ok: true }));
		await waitFor(() => mock.events.some((e) => e.type === "conversation.item.create" && e.item?.type === "function_call_output"), 3000);

		session.close();
	} finally {
		await mock.close();
	}
});

class FakeClientSocket extends EventEmitter {
	constructor() {
		super();
		this.readyState = WebSocket.OPEN;
		this.sent = [];
	}
	send(data) { this.sent.push(data); }
	close(code, reason) {
		this.readyState = WebSocket.CLOSED;
		this.emit("close", code, reason);
	}
	jsonMessages() {
		return this.sent.filter((entry) => typeof entry === "string").map((entry) => JSON.parse(entry));
	}
}

test("OpenAI-only /v1/live gateway exposes normalized tools and dispatches them", async () => {
	const mock = await startMockOpenAiRealtimeServer({ emitToolCall: true, toolName: "get_session_info" });
	const previous = {
		backend: process.env.PI_SPEAK_LIVE_BACKEND,
		url: process.env.PI_SPEAK_OPENAI_REALTIME_URL,
		google: process.env.GOOGLE_API_KEY,
		gemini: process.env.GEMINI_API_KEY,
	};
	process.env.PI_SPEAK_LIVE_BACKEND = "openai-realtime";
	process.env.PI_SPEAK_OPENAI_REALTIME_URL = mock.url;
	delete process.env.GOOGLE_API_KEY;
	delete process.env.GEMINI_API_KEY;
	const ws = new FakeClientSocket();
	const dashboard = {
		current: "pk",
		ready: ["pk"],
		sessions: [{ name: "pk", sessionId: "pk-id", sessionPath: "C:/sessions/pk.jsonl", current: true, isCurrent: true, ready: true, isReady: true, activity: "idle", aliases: [] }],
	};
	const server = {
		realtimeBridge: {
			getSessionDashboard: () => dashboard,
			agentHub: { snapshot: async () => ({ folders: [], agents: [] }) },
		},
	};
	try {
		handleRealtimeGateway.call(server, ws);
		ws.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "status" })), false);
		await waitFor(() => ws.jsonMessages().some((message) => message.type === "start"), 3000);
		await waitFor(() => mock.events.some((event) => event.type === "conversation.item.create" && event.item?.type === "function_call_output"), 3000);
		const update = mock.events.find((event) => event.type === "session.update");
		const terminal = update.session.tools.find((tool) => tool.name === "execute_terminal_command");
		assert.equal(terminal.parameters.type, "object");
		assert.equal(terminal.parameters.properties.command.type, "string");
		const outputEvent = mock.events.find((event) => event.type === "conversation.item.create" && event.item?.type === "function_call_output");
		assert.match(outputEvent.item.output, /pk/);
	} finally {
		ws.close();
		if (previous.backend === undefined) delete process.env.PI_SPEAK_LIVE_BACKEND; else process.env.PI_SPEAK_LIVE_BACKEND = previous.backend;
		if (previous.url === undefined) delete process.env.PI_SPEAK_OPENAI_REALTIME_URL; else process.env.PI_SPEAK_OPENAI_REALTIME_URL = previous.url;
		if (previous.google === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = previous.google;
		if (previous.gemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous.gemini;
		await mock.close();
	}
});

function waitFor(pred, timeoutMs) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (pred()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("timeout waiting for condition"));
			setTimeout(tick, 20);
		};
		tick();
	});
}
