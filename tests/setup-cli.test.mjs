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
			"--speak-gate",
			"enter",
			"--stt-backend",
			"auto",
			"--stt",
			"google",
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
		assert.equal(config.speakPlaybackGate, "enter");
		assert.equal(config.remoteSttBackend, "auto");
		assert.equal(config.remoteSttProvider, "google");
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
		// A fresh setup with no --speak-gate now defaults to the interactive
		// orb (no terminal autoplay).
		assert.match(stdout, /Playback gate: open interactive orb \(no autoplay\)/);
		assert.match(stdout, /Realtime terminal audit:/);

		// A deliberate re-opt-in to immediate via the current setup UI is
		// preserved: the saved config carries the current schema version, so
		// the legacy migration must not rewrite it.
		await execFileAsync(process.execPath, [
			"dist/pi-speak-pk.js",
			"setup",
			"--non-interactive",
			"--provider",
			"codex",
			"--tts",
			"edge",
			"--speak-gate",
			"immediate",
			"--token",
			"doctor-token-1234567890",
		], {
			cwd: process.cwd(),
			env: { ...process.env, PI_SPEAK_CONFIG_DIR: configDir },
		});
		const rerun = await execFileAsync(process.execPath, ["dist/pk-speak.js", "doctor"], {
			cwd: process.cwd(),
			env: { ...process.env, PI_SPEAK_CONFIG_DIR: configDir },
		});
		assert.match(rerun.stdout, /Playback gate: immediate/);
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}
});

test("pi-speak-pk doctor honors playback gate env override", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pi-speak-doctor-gate-test-"));
	try {
		await execFileAsync(process.execPath, [
			"dist/pi-speak-pk.js",
			"setup",
			"--non-interactive",
			"--provider",
			"codex",
			"--tts",
			"edge",
			"--speak-gate",
			"enter",
			"--token",
			"doctor-gate-token-1234567890",
		], {
			cwd: process.cwd(),
			env: { ...process.env, PI_SPEAK_CONFIG_DIR: configDir },
		});
		const { stdout } = await execFileAsync(process.execPath, ["dist/pi-speak-pk.js", "doctor"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				PI_SPEAK_CONFIG_DIR: configDir,
				PI_SPEAK_PLAYBACK_GATE: "immediate",
			},
		});
		assert.match(stdout, /Playback gate: immediate/);
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}
});

test("pk-speak doctor warns when process and user ElevenLabs keys differ", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pk-speak-doctor-env-test-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, ["dist/pk-speak.js", "doctor"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				PI_SPEAK_CONFIG_DIR: configDir,
				ELEVENLABS_API_KEY: "process-key",
				PI_SPEAK_TEST_USER_ENV_ELEVENLABS_API_KEY: "user-key",
			},
		});
		assert.match(stdout, /ElevenLabs key: configured \(process env, user env\)/);
		assert.match(stdout, /Warning: ELEVENLABS_API_KEY differs between this shell and the persisted user environment/);
		assert.doesNotMatch(stdout, /process-key/);
		assert.doesNotMatch(stdout, /user-key/);
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

test("pk-speak live dry-run reports gateway and desktop plans", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"live",
		"--dry-run",
		"--port",
		"8877",
		"--cwd",
		process.cwd(),
	], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /live gateway/i);
	assert.match(stdout, /AGENT_PROVIDER=gemini-live/);
	assert.match(stdout, /--gateway .*headless-gateway\.js/i);
	assert.match(stdout, /127\.0\.0\.1:8877\/orb\/\?mode=live&autoconnect=1/);
});

test("pk-speak live help describes the local realtime audio bridge", async () => {
	const { stdout } = await execFileAsync(process.execPath, ["dist/pk-speak.js", "live", "--help"], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /desktop app window/i);
	assert.match(stdout, /16 kHz microphone PCM/i);
});

test("pk-speak speak dry-run reads text args and sanitizes spoken output", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"speak",
		"--dry-run",
		"--provider",
		"edge",
		"Build",
		"--gate",
		"enter",
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
	assert.match(stdout, /Playback gate: press Enter before playback/);
	assert.doesNotMatch(stdout, /\*\*/);
});

test("pk-speak speak help makes OS media-player fallback explicit", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"speak",
		"--help",
	], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /--allow-open-fallback/);
	assert.match(stdout, /--gate <orb\|immediate\|enter>/);
	assert.match(stdout, /OS default app/);
});

test("pk-speak help includes wrap command", async () => {
	const { stdout } = await execFileAsync(process.execPath, ["dist/pk-speak.js", "--help"], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /pk-speak wrap/);
	assert.match(stdout, /Wrap examples:/);
});

test("pk-speak wrap help makes OS media-player fallback explicit", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"wrap",
		"--help",
	], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /--allow-open-fallback/);
	assert.match(stdout, /--gate <orb\|immediate\|enter>/);
	assert.match(stdout, /OS default app/);
});

test("pk-speak wrap dry-run reports command plan", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"wrap",
		"--dry-run",
		"--label",
		"Test Agent",
		"--",
		process.execPath,
		"-e",
		"console.log('ok')",
	], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /Command:/);
	assert.match(stdout, /Start notice: Starting Test Agent\./);
	assert.match(stdout, /Success notice: Test Agent finished successfully\./);
});

test("pk-speak wrap preserves command stdout and exit code when speech is disabled", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"wrap",
		"--no-speak",
		"--",
		process.execPath,
		"-e",
		"console.log('wrapped-ok')",
	], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /wrapped-ok/);
});

test("pk-speak wrap dry-run reports capture mode", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"wrap",
		"--dry-run",
		"--capture",
		"--",
		process.execPath,
		"-e",
		"console.log('ok')",
	], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /Capture: yes/);
});

test("pk-speak wrap capture mirrors output and classifies test failures", async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [
			"dist/pk-speak.js",
			"wrap",
			"--capture",
			"--no-speak",
			"--",
			process.execPath,
			"-e",
			"console.log('tests failed'); process.exit(2)",
		], {
			cwd: process.cwd(),
		}),
		(error) => {
			assert.match(error.stdout, /tests failed/);
			assert.match(error.stdout, /pk-speak capture: tests-failed, error/);
			assert.equal(error.code, 2);
			return true;
		},
	);
});

test("pk-speak wrap capture classifies approval prompts", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"dist/pk-speak.js",
		"wrap",
		"--capture",
		"--no-speak",
		"--",
		process.execPath,
		"-e",
		"console.log('Requires approval to continue')",
	], {
		cwd: process.cwd(),
	});
	assert.match(stdout, /pk-speak capture: approval-needed, needs-input/);
});

test("pk-speak retains every non-speak dispatcher family", async () => {
	const commands = [
		{ args: ["setup", "--help"], expected: /Usage: pk-speak setup/ },
		{ args: ["doctor", "--dry-run"], expected: /dry-run: pk-speak doctor/ },
		{ args: ["wrap", "--dry-run", "--", process.execPath, "-e", "console.log('ok')"], expected: [/Command:/, /Cwd:/, /Shell:/, /Capture:/] },
		{ args: ["brainstorm", "ideas.wav", "--dry-run"], expected: /dry-run: pk-speak brainstorm/ },
		{ args: ["gateway", "--dry-run"], expected: /dry-run: pk-speak gateway/ },
		{ args: ["tray", "--dry-run"], expected: /dry-run: pk-speak tray/ },
		{ args: ["mobile", "--dry-run"], expected: /dry-run: pk-speak mobile/ },
		{ args: ["admin", "--dry-run"], expected: /dry-run: pk-speak admin/ },
		{ args: ["config", "--dry-run"], expected: /dry-run: pk-speak config/ },
	];

	for (const { args, expected } of commands) {
		const { stdout } = await execFileAsync(process.execPath, ["dist/pk-speak.js", ...args], { cwd: process.cwd() });
		const expectedPatterns = Array.isArray(expected) ? expected : [expected];
		for (const expectedPattern of expectedPatterns) {
			assert.match(stdout, expectedPattern, `expected preserved dispatcher command: ${args[0]}`);
		}
	}
});
