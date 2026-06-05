import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { ControlServer } from "../dist/control-server.js";

const TEST_PORT = 18768;
const TEST_TOKEN = "test-secret-token";

test("WebSocket realtime gateway authentication and routing", async (t) => {
	let connectionReceived = false;
	const server = new ControlServer({
		state: {
			enabled: false,
			host: "127.0.0.1",
			port: TEST_PORT,
			authToken: TEST_TOKEN,
		},
		onStateChange: () => {},
		getStatus: () => ({}),
		getDiagnostics: () => ({}),
		getRoutingStatus: () => ({}),
		setRoutingTarget: () => ({ ok: true, message: "ok" }),
		onMonoAction: () => ({ ok: true, message: "ok" }),
		onSpeakAction: () => ({ ok: true, message: "ok" }),
		onPhoneAction: () => ({ ok: true, message: "ok" }),
		onTextTurn: async () => ({ replyText: "hello" }),
		onVoiceTurn: async () => ({ replyText: "hello" }),
		onRealtimeConnection: (ws) => {
			connectionReceived = true;
			ws.on("message", (msg) => {
				ws.send("echo:" + msg.toString());
			});
		},
	});

	await server.start();

	await t.test("rejects connection with invalid token", async () => {
		let connectionFailed = false;
		const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/live?token=wrong-token`, {
			headers: { Host: "tailnet.example" }
		});
		
		await new Promise((resolve) => {
			ws.on("error", () => {
				connectionFailed = true;
				resolve();
			});
			ws.on("open", () => {
				ws.close();
				resolve();
			});
		});

		assert.ok(connectionFailed, "Connection should be rejected (401)");
	});

	await t.test("accepts connection with valid token", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/live?token=${TEST_TOKEN}`, {
			headers: { Host: "tailnet.example" }
		});
		
		const opened = await new Promise((resolve) => {
			ws.on("open", () => {
				resolve(true);
			});
			ws.on("error", (err) => {
				resolve(false);
			});
		});

		assert.ok(opened, "WebSocket should connect successfully");
		assert.ok(connectionReceived, "onRealtimeConnection should be called");

		// Test basic message echo
		const replyPromise = new Promise((resolve) => {
			ws.on("message", (data) => {
				resolve(data.toString());
			});
		});

		ws.send("test-packet");
		const reply = await replyPromise;
		assert.equal(reply, "echo:test-packet");

		ws.close();
		await new Promise((resolve) => ws.on("close", resolve));
	});

	await server.stop();
});
