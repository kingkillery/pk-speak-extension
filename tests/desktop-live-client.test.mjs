import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDesktopLiveClientUrl,
	buildDesktopSpeechClientUrl,
	browserSupportsAppMode,
	findEdgePath,
	openDesktopLiveClient,
	openDesktopSpeechClient,
	resolvePreferredBrowserCandidate,
} from "../dist/desktop-live-client.js";

test("desktop live URL selects the terminal orb surface by default", () => {
	assert.equal(
		buildDesktopLiveClientUrl(8767, "C:\\dev\\pi-speak-extension"),
		"http://127.0.0.1:8767/orb/?mode=live&autoconnect=1&cwd=C%3A%5Cdev%5Cpi-speak-extension",
	);
	assert.equal(
		buildDesktopLiveClientUrl(8767, undefined, "app"),
		"http://127.0.0.1:8767/app/?mode=live&autoconnect=1",
	);
});

test("Edge discovery follows Windows install precedence", () => {
	const found = findEdgePath(
		{
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			ProgramFiles: "C:\\Program Files",
			LOCALAPPDATA: "C:\\Users\\prest\\AppData\\Local",
		},
		(candidate) => candidate.endsWith("Microsoft\\Edge\\Application\\msedge.exe") && candidate.includes("Program Files (x86)"),
	);
	assert.equal(found, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
});

test("browserSupportsAppMode recognizes Chromium family including Comet", () => {
	assert.equal(browserSupportsAppMode("C:\\Users\\x\\AppData\\Local\\Perplexity\\Comet\\Application\\comet.exe"), true);
	assert.equal(browserSupportsAppMode("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), true);
	assert.equal(browserSupportsAppMode("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), false);
});

test("resolvePreferredBrowserCandidate prefers OS default browser over Edge", () => {
	const comet = "C:\\Users\\x\\AppData\\Local\\Perplexity\\Comet\\Application\\comet.exe";
	const edge = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
	const candidate = resolvePreferredBrowserCandidate({
		env: { ProgramFiles: "C:\\Program Files" },
		pathExists: (p) => p === comet || p === edge,
		resolveDefaultBrowserPath: () => comet,
	});
	assert.deepEqual(candidate, {
		path: comet,
		source: "default",
		supportsAppMode: true,
	});
});

test("desktop live launcher prefers floating host with explicit Chromium BrowserPath", () => {
	const calls = [];
	const processStub = {
		pid: 42,
		on() { return this; },
		unref() {},
	};
	const hostScript = "C:\\dev\\repo\\scripts\\orb-desktop-host.ps1";
	const comet = "C:\\Users\\x\\AppData\\Local\\Perplexity\\Comet\\Application\\comet.exe";
	const result = openDesktopLiveClient({
		port: 8767,
		cwd: "C:\\dev\\repo",
		platform: "win32",
		env: { ProgramFiles: "C:\\Program Files" },
		pathExists: (candidate) => candidate === hostScript || candidate === comet,
		resolveDefaultBrowserPath: () => comet,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});

	assert.equal(result.mode, "floating-host");
	assert.equal(result.pid, 42);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "powershell.exe");
	assert.ok(calls[0].args.includes(hostScript));
	assert.ok(calls[0].args.includes("-BrowserPath"));
	assert.equal(calls[0].args[calls[0].args.indexOf("-BrowserPath") + 1], comet);
	assert.equal(calls[0].args[calls[0].args.indexOf("-Url") + 1].startsWith("http://127.0.0.1:8767/"), true);
});

test("desktop live launcher falls back to default-browser tab when browser lacks app-mode", () => {
	const calls = [];
	const processStub = {
		pid: 9,
		on() { return this; },
		unref() {},
	};
	const hostScript = "C:\\dev\\repo\\scripts\\orb-desktop-host.ps1";
	const firefox = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
	const result = openDesktopLiveClient({
		port: 8767,
		cwd: "C:\\dev\\repo",
		platform: "win32",
		env: {},
		pathExists: (candidate) => candidate === hostScript || candidate === firefox,
		resolveDefaultBrowserPath: () => firefox,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});

	assert.equal(result.mode, "default-browser");
	assert.equal(calls[0].command, firefox);
	assert.equal(calls[0].args[0], result.url);
	assert.equal(calls[0].args.some((a) => String(a).startsWith("--app=")), false);
});

test("desktop live launcher uses chromium app mode when floating host script is unavailable", () => {
	const calls = [];
	const processStub = {
		pid: 42,
		on() { return this; },
		unref() {},
	};
	const comet = "C:\\Users\\x\\AppData\\Local\\Perplexity\\Comet\\Application\\comet.exe";
	const result = openDesktopLiveClient({
		port: 8767,
		cwd: "C:\\dev\\repo",
		platform: "win32",
		env: {},
		pathExists: (candidate) => candidate === comet,
		resolveDefaultBrowserPath: () => comet,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});

	assert.equal(result.mode, "edge-app");
	assert.equal(calls[0].command, comet);
	assert.match(calls[0].args[0], /^--app=http:\/\/127\.0\.0\.1:8767\//);
});

test("Windows browser fallback passes the full live URL without a command shell", () => {
	const calls = [];
	const processStub = {
		pid: 7,
		on() { return this; },
		unref() {},
	};
	const result = openDesktopLiveClient({
		port: 8767,
		platform: "win32",
		env: {},
		pathExists: () => false,
		resolveDefaultBrowserPath: () => null,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});

	assert.equal(result.mode, "default-browser");
	assert.equal(calls[0].command, "explorer.exe");
	assert.equal(calls[0].args[0], result.url);
	assert.equal(calls[0].options.shell, undefined);
});

test("desktop live launcher falls back to the platform browser", () => {
	const calls = [];
	const processStub = {
		pid: 9,
		on() { return this; },
		unref() {},
	};
	const result = openDesktopLiveClient({
		port: 3001,
		platform: "darwin",
		spawnProcess(command, args) {
			calls.push({ command, args });
			return processStub;
		},
	});

	assert.equal(result.mode, "default-browser");
	assert.equal(calls[0].command, "open");
	assert.equal(calls[0].args[0], result.url);
});

test("speech URL is distinct from live URL: no autoconnect, speech= instead of mode=live", () => {
	const speech = buildDesktopSpeechClientUrl(8767, "abc-123", { authToken: "tok" });
	assert.match(speech, /mode=speech/);
	assert.match(speech, /speech=abc-123/);
	assert.doesNotMatch(speech, /autoconnect=1/);
	assert.doesNotMatch(speech, /mode=live/);
});

test("speech URL rejects invalid port and empty id", () => {
	assert.throws(() => buildDesktopSpeechClientUrl(0, "x"), /Invalid Pi Speak gateway port/);
	assert.throws(() => buildDesktopSpeechClientUrl(8767, "  "), /Speech id is required/);
});

test("openDesktopSpeechClient uses the speech URL on Windows floating host", () => {
	const calls = [];
	const processStub = { pid: 7, on() { return this; }, unref() {} };
	const hostScript = "C:\\dev\\repo\\scripts\\orb-desktop-host.ps1";
	const comet = "C:\\Users\\x\\AppData\\Local\\Perplexity\\Comet\\Application\\comet.exe";
	const result = openDesktopSpeechClient({
		port: 8767,
		cwd: "C:\\dev\\repo",
		speechId: "abc-123",
		authToken: "tok",
		platform: "win32",
		env: {},
		pathExists: (candidate) => candidate === hostScript || candidate === comet,
		resolveDefaultBrowserPath: () => comet,
		spawnProcess(command, args, options) {
			calls.push({ command, args, options });
			return processStub;
		},
	});
	assert.equal(result.mode, "floating-host");
	assert.equal(result.pid, 7);
	const urlArg = calls[0].args[calls[0].args.indexOf("-Url") + 1];
	assert.match(urlArg, /^http:\/\/127\.0\.0\.1:8767\/orb\/\?mode=speech&speech=abc-123/);
	assert.doesNotMatch(urlArg, /autoconnect=1/);
	assert.equal(calls[0].args[calls[0].args.indexOf("-BrowserPath") + 1], comet);
});

test("launched resolves ok:false when the launcher command fails to spawn (async ENOENT)", async () => {
	const processStub = {
		pid: undefined,
		handlers: {},
		on(event, listener) {
			this.handlers[event] = listener;
			return this;
		},
		unref() {},
	};
	const result = openDesktopLiveClient({
		port: 8767,
		platform: "linux",
		spawnProcess() {
			queueMicrotask(() => processStub.handlers.error?.(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })));
			return processStub;
		},
	});
	const launched = await result.launched;
	assert.equal(launched.ok, false);
});

test("launched resolves ok:true when the child emits spawn", async () => {
	const processStub = {
		pid: 11,
		handlers: {},
		on(event, listener) {
			this.handlers[event] = listener;
			return this;
		},
		unref() {},
	};
	const result = openDesktopLiveClient({
		port: 8767,
		platform: "linux",
		spawnProcess() {
			queueMicrotask(() => processStub.handlers.spawn?.());
			return processStub;
		},
	});
	const launched = await result.launched;
	assert.equal(launched.ok, true);
});
