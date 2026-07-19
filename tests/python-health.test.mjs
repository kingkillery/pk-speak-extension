import test from "node:test";
import assert from "node:assert/strict";
import { getPythonCommand } from "../dist/runtime-paths.js";

const REQUIRE_PYTHON_LISTENER_DEPS = /^(1|true|yes)$/i.test(
	process.env.PI_SPEAK_REQUIRE_PYTHON_LISTENER_DEPS ?? "",
);

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

test("Python listener dependencies are importable", async (t) => {
	const { execFile } = await import("node:child_process");
	const python = getPythonCommand();
	// Use importlib.util.find_spec to avoid slow model initialization on first faster_whisper import.
	const result = await new Promise((resolve) => {
		execFile(
			python,
			[
				"-c",
				"import importlib.util, sys; deps=['faster_whisper','sounddevice','numpy']; missing=[d for d in deps if importlib.util.find_spec(d) is None]; print(','.join(missing)); sys.exit(1 if missing else 0)",
			],
			{ encoding: "utf8", windowsHide: true },
			(error, stdout) => {
				resolve({ exitCode: error ? error.code ?? 1 : 0, missing: stdout.trim() });
			},
		);
	});
	if (result.exitCode !== 0 && !REQUIRE_PYTHON_LISTENER_DEPS) {
		t.skip(
			`Optional /mono dependencies not installed (${result.missing || "unknown"}). Set PI_SPEAK_REQUIRE_PYTHON_LISTENER_DEPS=1 to enforce.`,
		);
		return;
	}
	assert.equal(result.exitCode, 0, "faster_whisper, sounddevice, and numpy are all installed");
});
