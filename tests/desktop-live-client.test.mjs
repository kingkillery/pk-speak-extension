import test from "node:test";
import assert from "node:assert/strict";

import {
	buildDesktopLiveClientUrl,
	buildDesktopSpeechClientUrl,
	findEdgePath,
	openDesktopLiveClient,
	openDesktopSpeechClient,
} from "../dist/desktop-live-client.js";

test("desktop live URL selects the terminal orb surface by default", () => {
	assert.equal(
		buildDesktopLiveClientUrl(8767, "C:\\dev\\voice project"),
		"http://127.0.0.1:8767/orb/?mode=live&autoconnect=1&cwd=C%3A%5Cdev%5Cvoice+project",
	);
	assert.equal(
		buildDesktopLiveClientUrl(8767, undefined, "app"),
		"http://127.0.0.1:8767/app/?mode=live&autoconnect=1",
	);
	assert.throws(() => buildDesktopLiveClientUrl(0), /invalid.*port/i);
});

test("Edge discovery follows Windows install precedence", () => {
	const env = {
		"ProgramFiles(x86)": "C:\\Program Files (x86)",
		ProgramFiles: "C:\\Program Files",
		LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
	};
	const expected = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
	assert.equal(findEdgePath(env, (candidate) => candidate === expected), expected);
});

test("desktop live launcher uses Edge app mode on Windows", () => {
	const calls = [];
	const processStub = {
		pid: 42,
		on() { return this; },
		unref() {},
	};
	const result = openDesktopLiveClient({
		port: 8767,
		cwd: "C:\\dev\\repo",
		platform: "win32",
		env: { ProgramFiles: "C:\\Program Files" },
		pathExists: () => true,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});

	assert.equal(result.mode, "edge-app");
	assert.equal(result.pid, 42);
	assert.equal(calls.length, 1);
	assert.match(calls[0].command, /msedge\.exe$/i);
	assert.match(calls[0].args[0], /^--app=http:\/\/127\.0\.0\.1:8767\//);
	assert.equal(calls[0].options.detached, true);
});

test("Windows browser fallback passes the full live URL without a command shell", () => {
	const calls = [];
	const processStub = { on() { return this; }, unref() {} };
	openDesktopLiveClient({
		port: 8767,
		cwd: "C:\\dev\\workspace",
		platform: "win32",
		env: {},
		pathExists: () => false,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});
	assert.equal(calls[0].command, "explorer.exe");
	assert.equal(calls[0].args.length, 1);
	assert.match(calls[0].args[0], /mode=live&autoconnect=1&cwd=/);
});

test("desktop live launcher falls back to the platform browser", () => {
	const calls = [];
	const processStub = { on() { return this; }, unref() {} };
	const result = openDesktopLiveClient({
		port: 8767,
		platform: "linux",
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});
	assert.equal(result.mode, "default-browser");
	assert.equal(calls[0].command, "xdg-open");
});


test("speech URL is distinct from live URL: no autoconnect, speech= instead of mode=live", () => {
	const speechUrl = buildDesktopSpeechClientUrl(8767, "abc-123", { cwd: "C:\\dev\\repo", authToken: "secret-token" });
	const parsed = new URL(speechUrl);
	assert.equal(parsed.pathname, "/orb/");
	assert.equal(parsed.searchParams.get("mode"), "speech");
	assert.equal(parsed.searchParams.get("speech"), "abc-123");
	assert.equal(parsed.searchParams.get("token"), "secret-token");
	assert.equal(parsed.searchParams.get("autoconnect"), null, "speech mode must NOT set autoconnect=1");
	assert.equal(parsed.searchParams.get("cwd"), "C:\\dev\\repo");
});

test("speech URL rejects invalid port and empty id", () => {
	assert.throws(() => buildDesktopSpeechClientUrl(0, "id"), /invalid.*port/i);
	assert.throws(() => buildDesktopSpeechClientUrl(8767, "   "), /speech id/i);
});

test("openDesktopSpeechClient uses the speech URL on Windows", () => {
	const calls = [];
	const processStub = { pid: 7, on() { return this; }, unref() {} };
	const result = openDesktopSpeechClient({
		port: 8767,
		cwd: "C:\\dev\\repo",
		speechId: "abc-123",
		authToken: "tok",
		platform: "win32",
		env: { ProgramFiles: "C:\\Program Files" },
		pathExists: () => true,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});
	assert.equal(result.mode, "edge-app");
	assert.equal(result.pid, 7);
	assert.match(calls[0].args[0], /^--app=http:\/\/127\.0\.0\.1:8767\/orb\/\?mode=speech&speech=abc-123/);
	assert.doesNotMatch(calls[0].args[0], /autoconnect=1/);
});

test("launched resolves ok:false when the launcher command fails to spawn (async ENOENT)", async () => {
	// Command-not-found is an ASYNC "error" event — a sync try/catch around
	// openDesktopSpeechClient can never see it. The speech path deletes the
	// synthesized temp file on success, so this MUST surface as ok:false.
	const listeners = {};
	const processStub = {
		on(event, listener) { listeners[event] = listener; return this; },
		unref() {},
	};
	const result = openDesktopSpeechClient({
		port: 8767,
		speechId: "abc-123",
		platform: "linux",
		spawnProcess() { return processStub; },
	});
	queueMicrotask(() => listeners.error?.(new Error("spawn xdg-open ENOENT")));
	const launch = await result.launched;
	assert.equal(launch.ok, false);
	assert.match(launch.error, /ENOENT/);
});

test("launched resolves ok:true when the child emits spawn", async () => {
	const listeners = {};
	const processStub = {
		pid: 11,
		on(event, listener) { listeners[event] = listener; return this; },
		unref() {},
	};
	const result = openDesktopSpeechClient({
		port: 8767,
		speechId: "abc-123",
		platform: "linux",
		spawnProcess() { return processStub; },
	});
	queueMicrotask(() => listeners.spawn?.());
	const launch = await result.launched;
	assert.equal(launch.ok, true);
});