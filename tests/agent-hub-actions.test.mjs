import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOhMyPiLaunchArgv } from "../dist/agent-hub-actions.js";

function withTempDir(fn) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-launch-argv-"));
	try {
		return fn(tmp);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

test("buildOhMyPiLaunchArgv emits canonical argv order for a full launch", () => {
	withTempDir((tmp) => {
		const cwd = join(tmp, "project");
		const result = buildOhMyPiLaunchArgv({
			cwd,
			prompt: "summarize the failing tests",
			model: "gpt-5",
			provider: "openai",
			sessionDir: join(tmp, "agent-sessions"),
		}, tmp);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.mode, "launch");
		assert.equal(result.cwd, resolve(cwd));
		assert.deepEqual(result.argv, [
			"--cwd", resolve(cwd),
			"--session-dir", join(tmp, "agent-sessions"),
			"--model", "gpt-5",
			"--provider", "openai",
			"--", "summarize the failing tests",
		]);
	});
});

test("buildOhMyPiLaunchArgv falls back to fallbackCwd when cwd is omitted", () => {
	withTempDir((tmp) => {
		const result = buildOhMyPiLaunchArgv({ prompt: "ping" }, tmp);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.cwd, resolve(tmp));
		assert.deepEqual(result.argv, ["--cwd", resolve(tmp), "--", "ping"]);
	});
});

test("buildOhMyPiLaunchArgv omits optional flags when only cwd is set", () => {
	withTempDir((tmp) => {
		const result = buildOhMyPiLaunchArgv({ cwd: tmp }, "/unused");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.argv, ["--cwd", resolve(tmp)]);
	});
});

test("buildOhMyPiLaunchArgv returns hub mode argv when hubOnly is true and honors cwd", () => {
	withTempDir((tmp) => {
		const cwd = join(tmp, "fork-root");
		const result = buildOhMyPiLaunchArgv({ cwd, hubOnly: true }, "/unused");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.mode, "hub");
		assert.equal(result.cwd, resolve(cwd));
		assert.deepEqual(result.argv, ["bg"]);
	});
});

test("buildOhMyPiLaunchArgv rejects model/provider with embedded whitespace", () => {
	withTempDir((tmp) => {
		const embeddedSpace = buildOhMyPiLaunchArgv({ model: "gpt 5", cwd: tmp }, tmp);
		assert.equal(embeddedSpace.ok, false);
		if (embeddedSpace.ok) return;
		assert.match(embeddedSpace.message, /Invalid model/);

		const newline = buildOhMyPiLaunchArgv({ provider: "openai\nfoo", cwd: tmp }, tmp);
		assert.equal(newline.ok, false);
		if (newline.ok) return;
		assert.match(newline.message, /Invalid provider/);
	});
});

test("buildOhMyPiLaunchArgv rejects non-string cwd and oversize prompt", () => {
	withTempDir((tmp) => {
		const badCwd = buildOhMyPiLaunchArgv({ cwd: 42 }, tmp);
		assert.equal(badCwd.ok, false);
		if (badCwd.ok) return;
		assert.match(badCwd.message, /Invalid cwd/);

		const bigPrompt = "x".repeat(5000);
		const oversize = buildOhMyPiLaunchArgv({ prompt: bigPrompt, cwd: tmp }, tmp);
		assert.equal(oversize.ok, false);
		if (oversize.ok) return;
		assert.match(oversize.message, /exceeds 4096/);
	});
});
