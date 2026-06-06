import test from "node:test";
import assert from "node:assert/strict";
import {
	buildRealtimeWebSocketUrl,
	loadPersistedSettings,
	persistSettingsSnapshot,
	STORAGE_AUDIO,
	STORAGE_AUTOPLAY,
	STORAGE_REMEMBER,
	STORAGE_TOKEN,
} from "../web/remote/app.js";

test("buildRealtimeWebSocketUrl maps http origins to websocket live route", () => {
	assert.equal(
		buildRealtimeWebSocketUrl("http://127.0.0.1:8767", "token-1"),
		"ws://127.0.0.1:8767/v1/live?token=token-1",
	);
	assert.equal(
		buildRealtimeWebSocketUrl("https://example.tailnet.ts.net", ""),
		"wss://example.tailnet.ts.net/v1/live",
	);
});

test("query token boots into session-first auth state", () => {
	const settings = loadPersistedSettings({
		queryToken: "fresh-token",
		sessionToken: "",
		localToken: "old-token",
		rememberToken: false,
		audio: "true",
		autoplay: "false",
	});
	assert.equal(settings.token, "fresh-token");
	assert.equal(settings.rememberToken, false);
	assert.equal(settings.wantAudio, true);
	assert.equal(settings.autoplay, false);
	assert.equal(settings.shouldPersistQueryToken, true);
});

test("remember-device persistence only stores local token when enabled", () => {
	const remembered = persistSettingsSnapshot({
		token: "persisted-token",
		wantAudio: false,
		autoplay: true,
		rememberToken: true,
	});
	assert.deepEqual(remembered.session, { [STORAGE_TOKEN]: "persisted-token" });
	assert.equal(remembered.local[STORAGE_TOKEN], "persisted-token");
	assert.equal(remembered.local[STORAGE_REMEMBER], "true");
	assert.equal(remembered.local[STORAGE_AUDIO], "false");
	assert.equal(remembered.local[STORAGE_AUTOPLAY], "true");

	const sessionOnly = persistSettingsSnapshot({
		token: "session-token",
		wantAudio: true,
		autoplay: false,
		rememberToken: false,
	});
	assert.deepEqual(sessionOnly.session, { [STORAGE_TOKEN]: "session-token" });
	assert.equal(sessionOnly.clearLocalToken, true);
	assert.equal(sessionOnly.local[STORAGE_REMEMBER], "false");
});
