import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("pi-speak-pk help describes setup flow", async () => {
	const { stdout } = await execFileAsync(process.execPath, ["dist/pi-speak-pk.js", "--help"], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /Usage: pi-speak-pk/);
	assert.match(stdout, /pk-speak doctor/);
});

test("pi-speak-pk non-interactive setup writes local config", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pi-speak-setup-test-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [
			"dist/pi-speak-pk.js",
			"setup",
			"--non-interactive",
			"--provider",
			"claude",
			"--router",
			"auto",
			"--tts",
			"edge",
			"--mobile",
			"false",
			"--token",
			"test-token-1234567890",
		], {
			cwd: process.cwd(),
			env: { ...process.env, PI_SPEAK_CONFIG_DIR: configDir },
		});
		assert.match(stdout, /Saved setup/);
		const config = JSON.parse(await readFile(join(configDir, "setup.json"), "utf8"));
		assert.equal(config.agentProvider, "claude");
		assert.equal(config.executionRouterMode, "auto");
		assert.equal(config.ttsProvider, "edge");
		assert.equal(config.installMobileApp, false);
		assert.equal(config.httpToken, "test-token-1234567890");
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}
});

test("pk-speak doctor reads saved setup config", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pk-speak-doctor-test-"));
	try {
		await execFileAsync(process.execPath, [
			"dist/pi-speak-pk.js",
			"setup",
			"--non-interactive",
			"--provider",
			"codex",
			"--tts",
			"edge",
			"--token",
			"doctor-token-1234567890",
		], {
			cwd: process.cwd(),
			env: { ...process.env, PI_SPEAK_CONFIG_DIR: configDir },
		});
		const { stdout } = await execFileAsync(process.execPath, ["dist/pk-speak.js", "doctor"], {
			cwd: process.cwd(),
			env: { ...process.env, PI_SPEAK_CONFIG_DIR: configDir },
		});
		assert.match(stdout, /pk-speak doctor/);
		assert.match(stdout, /Agent provider: codex/);
		assert.match(stdout, /Gateway token: doct\.\.\.7890/);
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}
});

test("pk-speak help includes speak command", async () => {
	const { stdout } = await execFileAsync(process.execPath, ["dist/pk-speak.js", "--help"], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /pk-speak speak/);
	assert.match(stdout, /Speak examples:/);
});

test("pk-speak speak dry-run reads text args and sanitizes spoken output", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"speak",
		"--dry-run",
		"--provider",
		"edge",
		"Build",
		"finished",
		"with",
		"**success**",
	], {
		cwd: process.cwd(),
		env: { ...process.env, OPENROUTER_API_KEY: "" },
	});
	assert.match(stdout, /Requested provider: edge/);
	assert.match(stdout, /Provider: \w+/);
	assert.match(stdout, /Text: Build finished with success/);
	assert.doesNotMatch(stdout, /\*\*/);
});
