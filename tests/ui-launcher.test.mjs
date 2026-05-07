import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { launchSessionManagerPane, resolveAdminScriptPath } = await import("../dist/ui-launcher.js");

function makeStubSpawn() {
	const calls = [];
	let unrefed = false;
	const spawnImpl = (command, args, options) => {
		calls.push({ command, args: Array.from(args), options });
		return {
			unref() {
				unrefed = true;
			},
		};
	};
	return {
		spawnImpl,
		get calls() {
			return calls;
		},
		get unrefed() {
			return unrefed;
		},
	};
}

function withTempAdminScript(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-speak-ui-launcher-"));
	const adminPath = join(dir, "admin.js");
	writeFileSync(adminPath, "// stub\n");
	try {
		return fn(adminPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("launchSessionManagerPane spawns cmd.exe with start on win32", () => {
	withTempAdminScript((adminPath) => {
		const stub = makeStubSpawn();
		const result = launchSessionManagerPane({
			spawnImpl: stub.spawnImpl,
			platform: "win32",
			adminScriptPath: adminPath,
			nodeBinary: "C:/node/node.exe",
			lockPath: join(tmpdir(), `pi-speak-test-missing-${process.pid}.json`),
			currentSessionPath: "/sessions/bugfix.jsonl",
			currentSessionName: "voice bugfix",
		});

		assert.equal(result.spawned, true);
		assert.equal(result.command, "cmd.exe");
		assert.equal(result.detached, true);
		assert.deepEqual(result.args, [
			"/c",
			"start",
			"",
			"C:/node/node.exe",
			adminPath,
			"--current-path",
			"/sessions/bugfix.jsonl",
			"--current-name",
			"voice bugfix",
		]);
		assert.equal(stub.calls.length, 1);
		assert.equal(stub.calls[0].command, "cmd.exe");
		assert.deepEqual(stub.calls[0].args, [
			"/c",
			"start",
			"",
			"C:/node/node.exe",
			adminPath,
			"--current-path",
			"/sessions/bugfix.jsonl",
			"--current-name",
			"voice bugfix",
		]);
		assert.equal(stub.calls[0].options.detached, true);
		assert.equal(stub.calls[0].options.stdio, "ignore");
		assert.equal(stub.calls[0].options.shell, false);
		assert.equal(stub.unrefed, true);
	});
});

test("launchSessionManagerPane reuses existing pane when lock pid is alive", () => {
	withTempAdminScript((adminPath) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-speak-ui-lock-"));
		const lockPath = join(dir, "pane.lock.json");
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), "utf8");
		try {
			const stub = makeStubSpawn();
			const result = launchSessionManagerPane({
				spawnImpl: stub.spawnImpl,
				platform: "win32",
				adminScriptPath: adminPath,
				nodeBinary: "C:/node/node.exe",
				lockPath,
			});

			assert.equal(result.spawned, false);
			assert.equal(result.reused, true);
			assert.match(result.reason, /already running/i);
			assert.equal(stub.calls.length, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("launchSessionManagerPane returns manual command on unsupported platforms", () => {
	withTempAdminScript((adminPath) => {
		const stub = makeStubSpawn();
		const result = launchSessionManagerPane({
			spawnImpl: stub.spawnImpl,
			platform: "linux",
			adminScriptPath: adminPath,
			nodeBinary: "/usr/bin/node",
			lockPath: join(tmpdir(), `pi-speak-test-missing-${process.pid}.json`),
			currentSessionPath: "/sessions/bugfix.jsonl",
			currentSessionName: "voice bugfix",
		});

		assert.equal(result.spawned, false);
		assert.equal(stub.calls.length, 0);
		assert.match(result.manualCommand, /\/usr\/bin\/node/);
		assert.match(result.manualCommand, new RegExp(adminPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(result.manualCommand, /--current-path/);
		assert.match(result.manualCommand, /--current-name/);
		assert.ok(result.reason && /linux/i.test(result.reason));
	});
});

test("resolveAdminScriptPath resolves to a non-empty path when no override is provided", () => {
	const resolved = resolveAdminScriptPath();
	assert.ok(typeof resolved === "string" && resolved.length > 0);
	assert.match(resolved, /admin\.js$/);
});

test("/sess ui renders inline guidance instead of opening a terminal", async () => {
	const originalLocalAppData = process.env.LOCALAPPDATA;
	const originalAppData = process.env.APPDATA;
	const root = mkdtempSync(join(tmpdir(), "pi-speak-sess-ui-"));
	process.env.LOCALAPPDATA = root;
	process.env.APPDATA = root;
	try {
		const speakExtensionModule = await import("../dist/index.js");
		const speakExtension = speakExtensionModule.default?.default || speakExtensionModule.default || speakExtensionModule;

		const notifications = [];
		const pi = {
			commands: new Map(),
			events: new Map(),
			appended: [],
			messages: [],
			registerCommand(name, config) {
				this.commands.set(name, config);
			},
			on(name, handler) {
				this.events.set(name, handler);
			},
			appendEntry(customType, data) {
				this.appended.push({ customType, data });
			},
			setSessionName() {},
			getSessionName() {
				return "";
			},
			sendUserMessage() {},
		};
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = {
			hasUI: true,
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
				setStatus() {},
			},
			sessionManager: {
				getSessionFile() {
					return "";
				},
				getBranch() {
					return [];
				},
			},
			isIdle() {
				return true;
			},
			hasPendingMessages() {
				return false;
			},
			async newSession() {
				return { cancelled: false };
			},
			async switchSession() {
				return { cancelled: false };
			},
		};

		await sess.handler("ui", ctx);

		assert.ok(notifications.length > 0, "expected /sess ui to emit a notification");
		const last = notifications.at(-1);
		assert.match(last.message, /no longer opened by default/i);
		assert.match(last.message, /\/sess ui open/i);
	} finally {
		if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = originalLocalAppData;
		if (originalAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = originalAppData;
		rmSync(root, { recursive: true, force: true });
	}
});
