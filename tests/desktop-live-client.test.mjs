import test from "node:test";
import assert from "node:assert/strict";

import {
	buildDesktopLiveClientUrl,
	findEdgePath,
	openDesktopLiveClient,
} from "../dist/desktop-live-client.js";

test("desktop live URL selects realtime mode and carries the working directory", () => {
	assert.equal(
		buildDesktopLiveClientUrl(8767, "C:\\dev\\voice project"),
		"http://127.0.0.1:8767/app/?mode=live&autoconnect=1&cwd=C%3A%5Cdev%5Cvoice+project",
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
