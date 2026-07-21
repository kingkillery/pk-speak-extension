import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { ControlServer } from "../dist/control-server.js";
import { GoogleGenAI } from "@google/genai";

const tts = await import("../dist/tts.js");
const realtimeGatewayModule = await import("../dist/realtime-gateway.js");

const TEST_PORT = 19765;
const TEST_TOKEN = "production-readiness-test-token";

// Define a placeholder/mock for GoogleGenAI.prototype.live
let mockLiveConnectCallbacks = null;
let mockSessionInstance = null;

Object.defineProperty(GoogleGenAI.prototype, "live", {
	get() {
		return {
			connect: async (options) => {
				mockLiveConnectCallbacks = options.callbacks;
				mockSessionInstance = {
					options,
					sendRealtimeInput: (input) => {
						mockSessionInstance.lastRealtimeInput = input;
					},
					sendClientContent: (content) => {
						mockSessionInstance.lastClientContent = content;
					},
					close: () => {
						mockSessionInstance.closed = true;
					}
				};
				// Mirror the real Gemini Live handshake: onopen, then a
				// setupComplete server message. The gateway deliberately does
				// not send its "start" frame until setupComplete arrives
				// (see "does not mark the browser live session ready before
				// Gemini setup completes" in the dispatch integration test),
				// so a mock that only fires onopen never yields a session.
				setTimeout(() => {
					options.callbacks?.onopen?.();
					options.callbacks?.onmessage?.({ setupComplete: true });
				}, 5);
				return mockSessionInstance;
			}
		};
	},
	set(val) {},
	configurable: true
});

test("Production Readiness E2E Integration Suite", async (t) => {
	// Set environment variables required for mock configuration
	process.env.GEMINI_API_KEY = "mock-gemini-key";
	process.env.PI_SPEAK_TTS_PROVIDER = "elevenlabs";
	process.env.ELEVENLABS_API_KEY = "mock-elevenlabs-key";

	let cancelCallbackCalled = false;

	const server = new ControlServer({
		state: {
			enabled: true,
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
		onTurnCancel: async () => {
			cancelCallbackCalled = true;
		},
		onRealtimeConnection: (ws) => {
			realtimeGatewayModule.handleRealtimeGateway(ws);
		},
	});

	await server.start();

	try {
		await t.test("WebSocket Reconnection & Queue Buffer", async () => {
			const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/live?token=${TEST_TOKEN}`, {
				headers: { Host: "tailnet.example" }
			});

			const messages = [];
			ws.on("message", (data) => {
				messages.push(JSON.parse(data.toString()));
			});

			const opened = await new Promise((resolve) => {
				ws.on("open", () => resolve(true));
			});

			assert.ok(opened, "WebSocket should connect successfully");

			// Wait for 500ms startup threshold to fire, plus safety padding
			await new Promise((resolve) => setTimeout(resolve, 650));
			assert.ok(messages.length > 0, "Should have received initial start message after 650ms");
			const startMsg = messages.find((message) => message.type === "start");
			assert.ok(startMsg, "Expected a start message after setup");
			const sessionId = startMsg.session;
			assert.ok(sessionId, "Session ID should be generated");

			// Terminate abruptly to simulate connection loss
			if (ws.readyState === WebSocket.OPEN) {
				const closePromise = new Promise((resolve) => ws.once("close", () => resolve(true)));
				ws.terminate();
				await closePromise;
			}

			// Now simulate server generating a message to client while disconnected
			const activeSession = realtimeGatewayModule.activeSessions?.get(sessionId);
			assert.ok(activeSession, "Session should persist in server activeSessions map");
			
			// Send message while disconnected
			realtimeGatewayModule.sendToClient(activeSession, { type: "text", text: "buffered message" }, false);
			assert.equal(activeSession.pendingServerMessages.length, 1, "Message should be queued in pending buffer");

			// Reconnect client using reconnect payload
			const reconnectWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/live?token=${TEST_TOKEN}`, {
				headers: { Host: "tailnet.example" }
			});

			const reconnectMessages = [];
			reconnectWs.on("message", (data) => {
				reconnectMessages.push(JSON.parse(data.toString()));
			});

			const reconnected = await new Promise((resolve) => {
				reconnectWs.on("open", () => resolve(true));
			});

			assert.ok(reconnected, "Reconnect WebSocket should connect successfully");

			// Send the reconnect command immediately
			reconnectWs.send(JSON.stringify({
				type: "reconnect",
				session: sessionId,
				reconnectToken: startMsg.reconnectToken,
				serverSequenceId: startMsg.serverSequenceId || 1
			}));

			// Wait for flush
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Reconnect should flush the buffered message
			assert.ok(reconnectMessages.some(m => m.type === "text" && m.text === "buffered message"), "Reconnected client should receive the buffered message");

			if (reconnectWs.readyState === WebSocket.OPEN) {
				const reconnectClosePromise = new Promise((resolve) => reconnectWs.once("close", resolve));
				reconnectWs.terminate();
				await reconnectClosePromise;
			}
		});

		await t.test("Barge-in / Interruption Event", async () => {
			cancelCallbackCalled = false;
			const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/live?token=${TEST_TOKEN}`, {
				headers: { Host: "tailnet.example" }
			});

			const messages = [];
			ws.on("message", (data) => {
				messages.push(JSON.parse(data.toString()));
			});

			await new Promise((resolve) => ws.on("open", resolve));

			// Send interrupt signal
			ws.send(JSON.stringify({ type: "interrupt" }));
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.ok(cancelCallbackCalled, "onTurnCancel should be triggered by interrupt packet");
			assert.ok(messages.some(m => m.type === "interrupt"), "Server should echo back the interrupt packet to client");

			const closePromise = new Promise((resolve) => ws.once("close", resolve));
			ws.terminate();
			await closePromise;
		});

		await t.test("TTS Fallback Pipeline", async () => {
			let elevenLabsCalled = false;
			let edgeCalled = false;

			// Inject mock implementations
			tts.testOverrides.synthesizeElevenLabs = async (text, path, signal) => {
				elevenLabsCalled = true;
				throw new Error("ElevenLabs Rate Limit (429)");
			};

			tts.testOverrides.synthesizeEdge = async (text, path, signal) => {
				edgeCalled = true;
			};

			const result = await tts.synthesizeToFile({
				text: "Test fallback output",
				outputPath: "dummy-path.mp3",
				state: { provider: "elevenlabs", rewriteEnabled: false }
			});

			assert.ok(elevenLabsCalled, "synthesizeElevenLabs should have been tried first");
			assert.ok(edgeCalled, "Should have fallen back to synthesizeEdge");
			assert.equal(result.provider, "edge", "Result provider should be edge after fallback");

			// Restore original functions
			tts.testOverrides.synthesizeElevenLabs = null;
			tts.testOverrides.synthesizeEdge = null;
		});
	} finally {
		// Clean up active sessions disconnect timers to allow clean process exit
		if (realtimeGatewayModule.activeSessions) {
			for (const session of realtimeGatewayModule.activeSessions.values()) {
				if (session.disconnectTimeout) {
					clearTimeout(session.disconnectTimeout);
				}
				try {
					session.session?.close();
				} catch {}
			}
			realtimeGatewayModule.activeSessions.clear();
		}
		await server.stop();
	}
});
