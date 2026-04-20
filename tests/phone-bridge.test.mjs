import test from "node:test";
import assert from "node:assert/strict";
import { TelegramPhoneBridge } from "../dist/phone-bridge.js";

test("telegram bridge links and forwards text turns", async () => {
	const updatesQueue = [
		[{ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "/link 123456" } }],
		[{ update_id: 2, message: { message_id: 2, chat: { id: 42 }, text: "hello pi" } }],
		[],
	];
	const sentMessages = [];
	const statePatches = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const urlText = String(url);
		if (urlText.includes("/getUpdates")) {
			return {
				ok: true,
				json: async () => ({ ok: true, result: updatesQueue.shift() || [] }),
			};
		}
		if (urlText.includes("/sendMessage") || urlText.includes("/sendChatAction")) {
			sentMessages.push(urlText);
			return {
				ok: true,
				json: async () => ({ ok: true, result: true }),
			};
		}
		throw new Error(`Unexpected fetch: ${urlText}`);
	};

	try {
		const bridge = new TelegramPhoneBridge({
			token: "test-token",
			state: {
				enabled: false,
				linkCode: "123456",
			},
			getStatusText: () => "status",
			onStateChange: (patch) => {
				statePatches.push(patch);
			},
			onTextTurn: async (text) => ({ replyText: `reply:${text}` }),
			onVoiceBuffer: async () => ({ replyText: "voice" }),
		});

		bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 80));
		await bridge.stop();

		const status = bridge.getStatus();
		assert.equal(status.linkedChatId, "42");
		assert.ok(sentMessages.some((entry) => entry.includes("/sendMessage")));
		assert.ok(statePatches.some((patch) => patch.linkedChatId === "42"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("telegram bridge adds abort signals to outbound requests", async () => {
	const originalFetch = globalThis.fetch;
	const seenSignals = [];
	globalThis.fetch = async (_url, options = {}) => {
		seenSignals.push(options.signal);
		return {
			ok: true,
			json: async () => ({ ok: true, result: [] }),
		};
	};

	try {
		const bridge = new TelegramPhoneBridge({
			token: "test-token",
			state: {
				enabled: false,
				linkCode: "123456",
			},
			getStatusText: () => "status",
			onStateChange: () => {},
			onTextTurn: async (text) => ({ replyText: text }),
			onVoiceBuffer: async () => ({ replyText: "voice" }),
		});

		bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await bridge.stop();

		assert.ok(seenSignals.length > 0);
		assert.ok(seenSignals.every((signal) => signal instanceof AbortSignal));
	} finally {
		globalThis.fetch = originalFetch;
	}
});
