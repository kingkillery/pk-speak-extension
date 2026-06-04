import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The wake-phrase logic that powers `/mono` lives in listener/listener.py. Its
// pure helpers are covered by tests/listener_wake_test.py (Python unittest); this
// wrapper runs them as part of `npm test` so a JS-only `node --test` run still
// enforces the Python contract. It skips gracefully when no interpreter exists.

const here = dirname(fileURLToPath(import.meta.url));
const pyTest = join(here, "listener_wake_test.py");

function findPython() {
	for (const candidate of ["python3", "python"]) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
		if (!probe.error && probe.status === 0) return candidate;
	}
	return null;
}

test("listener.py wake-phrase helpers (python unittest)", (t) => {
	const python = findPython();
	if (!python) {
		t.skip("no python interpreter available");
		return;
	}
	const result = spawnSync(python, [pyTest], { cwd: here, encoding: "utf8" });
	if (result.status !== 0) {
		assert.fail(
			`listener wake-phrase python tests failed (exit ${result.status}):\n` +
				`${result.stdout || ""}\n${result.stderr || ""}`,
		);
	}
});
