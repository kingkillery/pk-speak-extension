import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnDetached } from "../dist/spawn-shim.js";
import { buildOhMyPiLaunchArgv } from "../dist/agent-hub-actions.js";

async function waitForFile(path, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function withTempDir(fn) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-spawn-shim-"));
	try {
		return fn(tmp);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

test("buildOhMyPiLaunchArgv keeps shell metacharacters literal in the prompt argv element", () => {
	withTempDir((tmp) => {
		const evil = 'fix the bug && calc.exe | "quoted" ^ %PATH%';
		const result = buildOhMyPiLaunchArgv({ cwd: join(tmp, "project"), prompt: evil }, tmp);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		// The prompt is the final argv element, guarded by a literal "--" separator.
		assert.equal(result.argv[result.argv.length - 2], "--");
		assert.equal(result.argv[result.argv.length - 1], evil);
	});
});

test("spawnDetached passes arguments literally without shell interpretation", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-spawn-shim-run-"));
	try {
		const outFile = join(tmp, "argv.json");
		const evil = 'a && b | c "d" ^e %F%';
		// The child writes its extra argv to a file. If a shell had interpreted the
		// string, the metacharacters would split it (or run side effects) instead of
		// arriving as a single literal element.
		const script = "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))";
		const child = spawnDetached(process.execPath, ["-e", script, outFile, evil], tmp);
		child.on("error", (err) => assert.fail(err));
		// The child is detached, so poll for its output rather than trusting the
		// parent-side "close" event (which can fire before the file is flushed).
		await waitForFile(outFile);
		const received = JSON.parse(readFileSync(outFile, "utf8"));
		assert.deepEqual(received, [evil]);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
