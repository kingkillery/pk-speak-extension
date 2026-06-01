import test from "node:test";
import assert from "node:assert/strict";
import { getPythonCommand } from "../dist/runtime-paths.js";

test("getPythonCommand returns a non-empty string", () => {
	const cmd = getPythonCommand();
	assert.ok(typeof cmd === "string" && cmd.length > 0, "Python command is a non-empty string");
});

test("Python executable is available in PATH", async () => {
	const { execFile } = await import("node:child_process");
	const python = getPythonCommand();
	const version = await new Promise((resolve, reject) => {
		execFile(python, ["--version"], { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
			if (error) reject(error);
			else resolve(stdout.trim() || stderr.trim());
		});
	});
	assert.match(version, /Python \d+\.\d+/);
});

test("Python listener dependencies are importable", async () => {
	const { execFile } = await import("node:child_process");
	const python = getPythonCommand();
	// Use importlib.util.find_spec to avoid slow model initialization on first faster_whisper import.
	const result = await new Promise((resolve, reject) => {
		execFile(
			python,
			["-c", "import importlib.util, sys; deps=['faster_whisper','sounddevice','numpy']; missing=[d for d in deps if importlib.util.find_spec(d) is None]; sys.exit(1 if missing else 0)"],
			{ encoding: "utf8", windowsHide: true },
			(error) => {
				resolve(error ? error.code ?? 1 : 0);
			},
		);
	});
	assert.equal(result, 0, "faster_whisper, sounddevice, and numpy are all installed");
});
