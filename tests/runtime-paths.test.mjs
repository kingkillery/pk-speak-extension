import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
	getPythonCommand,
	getSpeakInvocationFromEnv,
	listUserSiteScriptCandidates,
} = await import("../dist/runtime-paths.js");

function withTempHome(fn) {
	const root = mkdtempSync(join(tmpdir(), "pi-speak-runtime-paths-"));
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("getPythonCommand honors PI_SPEAK_PYTHON when set", () => {
	const env = { PI_SPEAK_PYTHON: "C:/custom/python.exe" };
	assert.equal(getPythonCommand(env), "C:/custom/python.exe");
});

test("listUserSiteScriptCandidates prefers the highest Python* scripts directory", () => {
	withTempHome((home) => {
		const py311 = join(home, "AppData", "Roaming", "Python", "Python311", "Scripts");
		const py314 = join(home, "AppData", "Roaming", "Python", "Python314", "Scripts");
		mkdirSync(py311, { recursive: true });
		mkdirSync(py314, { recursive: true });
		writeFileSync(join(py311, "speak11.py"), "# 311\n");
		writeFileSync(join(py314, "speak11.py"), "# 314\n");

		const candidates = listUserSiteScriptCandidates("speak11.py", {
			USERPROFILE: home,
			HOME: home,
		});
		assert.equal(candidates.length, 2);
		assert.match(candidates[0], /Python314/);
		assert.match(candidates[1], /Python311/);
	});
});

test("getSpeakInvocationFromEnv honors PI_SPEAK_SPEAK11_PATH for python scripts", () => {
	const invocation = getSpeakInvocationFromEnv(
		"out.wav",
		"alloy",
		{
			PI_SPEAK_PYTHON: "C:/python/python.exe",
			PI_SPEAK_SPEAK11_PATH: "C:/tools/speak11.py",
		},
	);
	assert.equal(invocation.command, "C:/python/python.exe");
	assert.deepEqual(invocation.args, [
		"C:/tools/speak11.py",
		"--stdin",
		"-s",
		"-v",
		"alloy",
		"-o",
		"out.wav",
	]);
});

test("getSpeakInvocationFromEnv honors PI_SPEAK_SPEAK11_PATH for command wrappers", () => {
	const invocation = getSpeakInvocationFromEnv(
		"out.wav",
		"alloy",
		{
			PI_SPEAK_SPEAK11_PATH: "C:/tools/speak11.cmd",
		},
	);
	assert.equal(invocation.command, "cmd.exe");
	assert.deepEqual(invocation.args, [
		"/c",
		"C:/tools/speak11.cmd",
		"--stdin",
		"-s",
		"-v",
		"alloy",
		"-o",
		"out.wav",
	]);
});

test("getSpeakInvocationFromEnv falls back to newest user-site speak11.py", () => {
	withTempHome((home) => {
		const py311 = join(home, "AppData", "Roaming", "Python", "Python311", "Scripts");
		const py313 = join(home, "AppData", "Roaming", "Python", "Python313", "Scripts");
		mkdirSync(py311, { recursive: true });
		mkdirSync(py313, { recursive: true });
		writeFileSync(join(py311, "speak11.py"), "# 311\n");
		writeFileSync(join(py313, "speak11.py"), "# 313\n");

		const invocation = getSpeakInvocationFromEnv(
			"out.wav",
			"alloy",
			{
				USERPROFILE: home,
				HOME: home,
				PI_SPEAK_PYTHON: "C:/python/python.exe",
			},
		);
		assert.equal(invocation.command, "C:/python/python.exe");
		assert.match(invocation.args[0], /Python313/);
	});
});
