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

test("telegram bridge generates a six-digit numeric link code", () => {
	const bridge = new TelegramPhoneBridge({
		token: "test-token",
		state: { enabled: false },
		getStatusText: () => "",
		onStateChange: () => {},
		onTextTurn: async () => ({ replyText: "" }),
		onVoiceBuffer: async () => ({ replyText: "" }),
	});
	const code = bridge.getStatus().linkCode;
	assert.match(code, /^\d{6}$/);
	const value = Number(code);
	assert.ok(value >= 100000 && value <= 999999);
});

test("telegram bridge locks out and rotates the code after repeated bad link attempts", async () => {
	const wrong = (id) => ({ update_id: id, message: { message_id: id, chat: { id: 99 }, text: "/link 000000" } });
	const updatesQueue = [
		[wrong(1), wrong(2), wrong(3), wrong(4), wrong(5), wrong(6)],
		[],
	];
	const sentTexts = [];
	const statePatches = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const urlText = String(url);
		if (urlText.includes("/getUpdates")) {
			return { ok: true, json: async () => ({ ok: true, result: updatesQueue.shift() || [] }) };
		}
		if (urlText.includes("/sendMessage")) {
			const body = options.body;
			sentTexts.push(body && typeof body.get === "function" ? body.get("text") : "");
			return { ok: true, json: async () => ({ ok: true, result: true }) };
		}
		if (urlText.includes("/sendChatAction")) {
			return { ok: true, json: async () => ({ ok: true, result: true }) };
		}
		throw new Error(`Unexpected fetch: ${urlText}`);
	};

	try {
		const bridge = new TelegramPhoneBridge({
			token: "test-token",
			state: { enabled: false, linkCode: "123456", linkCodeIssuedAt: Date.now() },
			getStatusText: () => "status",
			onStateChange: (patch) => statePatches.push(patch),
			onTextTurn: async (text) => ({ replyText: text }),
			onVoiceBuffer: async () => ({ replyText: "voice" }),
		});

		bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 150));
		await bridge.stop();

		const status = bridge.getStatus();
		// Code rotated (burned) after the 5th failed attempt, so brute forcing is reset.
		assert.notEqual(status.linkCode, "123456");
		assert.equal(status.linkedChatId, undefined);
		// Lockout window recorded in persisted state.
		assert.ok(statePatches.some((patch) => typeof patch.linkLockoutUntil === "number" && patch.linkLockoutUntil > Date.now()));
		// The attacker sees the lockout notice, and the 6th attempt is refused outright.
		assert.ok(sentTexts.some((text) => /too many attempts/i.test(text || "")));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("resetLink clears an active lockout so the freshly-issued code works immediately", () => {
	// Regression: rotateLinkCode() is shared by the auto-lockout path and this
	// manual reset/unpair path. A prior bug left linkLockoutUntil set after a
	// manual reset, silently rejecting the brand-new code the status message
	// says is ready to use.
	const bridge = new TelegramPhoneBridge({
		token: "test-token",
		state: { enabled: false, linkCode: "123456", linkLockoutUntil: Date.now() + 5 * 60 * 1000 },
		getStatusText: () => "",
		onStateChange: () => {},
		onTextTurn: async () => ({ replyText: "" }),
		onVoiceBuffer: async () => ({ replyText: "" }),
	});
	assert.ok(bridge.getStatus().linkLockoutUntil > Date.now());
	bridge.resetLink();
	assert.equal(bridge.getStatus().linkLockoutUntil, undefined);
});
