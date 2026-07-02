import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildColabLaunchPlan, buildOhMyPiLaunchArgv, validateOmpSelection } from "../dist/agent-hub-actions.js";

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

test("buildOhMyPiLaunchArgv accepts targetNode option and propagates it to result", () => {
	withTempDir((tmp) => {
		const cwd = join(tmp, "project");
		const result = buildOhMyPiLaunchArgv({
			cwd,
			prompt: "ping",
			targetNode: "colab",
		}, tmp);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.targetNode, "colab");
	});
});

test("buildOhMyPiLaunchArgv rejects unsupported targetNode and hub target conflicts", () => {
	withTempDir((tmp) => {
		const unsupported = buildOhMyPiLaunchArgv({ cwd: tmp, targetNode: "gpu" }, tmp);
		assert.equal(unsupported.ok, false);
		if (unsupported.ok) return;
		assert.match(unsupported.message, /unsupported target/);

		const conflict = buildOhMyPiLaunchArgv({ cwd: tmp, hubOnly: true, targetNode: "colab" }, tmp);
		assert.equal(conflict.ok, false);
		if (conflict.ok) return;
		assert.match(conflict.message, /hubOnly cannot be combined/);
	});
});

test("buildColabLaunchPlan emits mesh-sync colab-deploy argv with a stable run id", () => {
	withTempDir((tmp) => {
		const cwd = join(tmp, "project");
		const env = { APPDATA: "C:\\Users\\prest\\AppData\\Roaming" };
		const result = buildColabLaunchPlan({ cwd }, tmp, env, () => 1782208800000);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.cwd, resolve(cwd));
		assert.equal(result.runId, "colab-1782208800000");
		assert.equal(result.session, "mesh-colab");
		assert.equal(result.target, "/content/workspace");
		assert.equal(result.command, "C:\\Users\\prest\\AppData\\Roaming\\Antigravity\\bin\\mesh-sync.cmd");
		assert.deepEqual(result.argv, [
			"colab-deploy", resolve(cwd),
			"--run-id", "colab-1782208800000",
			"--session", "mesh-colab",
			"--target", "/content/workspace",
		]);
		assert.equal(result.shell, process.platform === "win32");
		assert.match(result.commandPreview, /colab-deploy/);
	});
});

test("buildColabLaunchPlan honors command overrides and rejects invalid target path", () => {
	withTempDir((tmp) => {
		const custom = buildColabLaunchPlan({
			cwd: tmp,
			command: "mesh-sync-custom",
			runId: "run-1",
			session: "session-1",
			target: "/content/custom",
		}, "/unused", {}, () => 1);
		assert.equal(custom.ok, true);
		if (!custom.ok) return;
		assert.equal(custom.command, "mesh-sync-custom");
		assert.deepEqual(custom.argv, [
			"colab-deploy", resolve(tmp),
			"--run-id", "run-1",
			"--session", "session-1",
			"--target", "/content/custom",
		]);

		const invalid = buildColabLaunchPlan({ cwd: tmp, target: "/content/workspace\nbad" }, "/unused");
		assert.equal(invalid.ok, false);
		if (invalid.ok) return;
		assert.match(invalid.message, /Invalid target/);
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

test("validateOmpSelection accepts a real in-roots session, rejects bad ones, allows deselect", () => {
	withTempDir((tmp) => {
		const root = join(tmp, "sessions");
		const projectDir = join(root, "proj");
		mkdirSync(projectDir, { recursive: true });
		const realPath = join(projectDir, "2026-06-23T000000_s.jsonl");
		writeFileSync(realPath, `${JSON.stringify({ type: "session", id: "s" })}\n`);
		const env = { PI_SPEAK_OH_MY_PK_SESSIONS_ROOT: root };

		// Deselect is always ok.
		assert.deepEqual(validateOmpSelection(null, env), { ok: true });
		assert.deepEqual(validateOmpSelection("", env), { ok: true });
		assert.deepEqual(validateOmpSelection("   ", env), { ok: true });

		// Real path under roots → ok.
		assert.deepEqual(validateOmpSelection(realPath, env), { ok: true });

		// Outside configured roots → rejected.
		const outside = validateOmpSelection(join(tmp, "elsewhere", "x.jsonl"), env);
		assert.equal(outside.ok, false);
		assert.match(outside.error, /outside the configured oh-my-pk roots/);

		// Under roots but does not exist → rejected.
		const missing = validateOmpSelection(join(projectDir, "gone.jsonl"), env);
		assert.equal(missing.ok, false);
		assert.match(missing.error, /does not exist/);
	});
});
