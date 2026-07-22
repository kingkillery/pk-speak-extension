import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { spawnDetached } from "../dist/spawn-shim.js";
import { buildOhMyPiLaunchArgv } from "../dist/agent-hub-actions.js";
// cross-spawn caches `process.platform` at module load time (lib/parse.js),
// so the cmd.exe-quoting branch can't be exercised end-to-end on non-Windows
// CI. This repo also has no CI at all yet (a separate, tracked gap). As a
// partial substitute, verify the actual escaping helper cross-spawn uses on
// Windows neutralizes the same metacharacters our attack strings contain.
import escapeUtil from "cross-spawn/lib/util/escape.js";

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
		rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
		const childExited = once(child, "exit");
		// The child is detached, so poll for its output rather than trusting the
		// parent-side "close" event (which can fire before the file is flushed).
		await waitForFile(outFile);
		const received = JSON.parse(readFileSync(outFile, "utf8"));
		assert.deepEqual(received, [evil]);
		await childExited;
	} finally {
		// The detached child keeps `tmp` as its cwd briefly after writing the
		// file, so a bare rmSync can hit EPERM on Windows. Retry instead.
		rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("cross-spawn's Windows cmd.exe escaping neutralizes shell metacharacters in a malicious prompt", () => {
	// This is what spawnDetached/safeSpawn delegate to on Windows when the
	// resolved binary is a .cmd/.bat shim (see lib/parse.js: parseNonShell).
	// cross-spawn caret-escapes every cmd.exe metacharacter it finds (including
	// the space and quote characters its own quoting pass introduces), so the
	// real property to check is: no metacharacter survives *unescaped* (i.e. not
	// immediately preceded by a caret) anywhere in the output.
	const evil = 'launch && calc.exe | whoami > out.txt & echo pwned ^ "quoted" % PATH %';
	const escaped = escapeUtil.argument(evil, false);
	assert.notEqual(escaped, evil);
	// "^" itself is excluded: it's the escape prefix, so a bare "^" preceding
	// another metachar is expected and correct, not a bug.
	for (const meta of ["&", "|", ">", "<", "%", '"', "(", ")"]) {
		const bareMeta = new RegExp(`(?<!\\^)${meta.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
		assert.ok(!bareMeta.test(escaped), `unescaped ${JSON.stringify(meta)} found in: ${escaped}`);
	}
});
