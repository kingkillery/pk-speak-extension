import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Regression coverage for the orb's "Disable speech" button end-to-end:
 * clicking it writes the hard-stop sentinel, so subsequent `pk-speak speak`
 * invocations must honor it BEFORE synthesis — no audio file produced, no
 * orb staged, no autoplay fallback. The supported re-enable path is
 * `pk-speak enable` (the orb is unreachable from the CLI once disabled).
 */

function runPkSpeak({ env, args }) {
	return new Promise((resolvePromise, rejectPromise) => {
		const entry = resolve("dist/pk-speak.js");
		const child = spawn(process.execPath, [entry, ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		child.on("error", rejectPromise);
		child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

/**
 * Higher-order test wrapper. Pre-places the disable sentinel in an isolated
 * config dir / userprofile, hands the test a configured env, and tears down
 * on completion. Use as `test(name, withDisabledSpeechEnv(async ({...}) => ...))`.
 */
function withDisabledSpeechEnv(callback) {
	return async (t) => {
		const previousConfigDir = process.env.PI_SPEAK_CONFIG_DIR;
		const previousUserprofile = process.env.USERPROFILE;
		const previousHome = process.env.HOME;
		const brokerRoot = mkdtempSync(join(tmpdir(), "pk-speak-disable-broker-"));
		const userRoot = mkdtempSync(join(tmpdir(), "pk-speak-disable-user-"));
		const configDir = join(brokerRoot, "pi-speak");
		const disablePath = join(configDir, "voice-disabled");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(disablePath, "hard-stop\n", { encoding: "utf8" });
		const env = {
			...process.env,
			PI_SPEAK_CONFIG_DIR: configDir,
			USERPROFILE: userRoot,
			HOME: userRoot,
			// Force a non-existent gateway port so even if the disable check
			// were bypassed, the orb path could not silently succeed.
			PI_SPEAK_HTTP_PORT: "1",
			PI_SPEAK_PLAYBACK_GATE: "orb",
		};
		try {
			await callback({ env, disablePath, outputPath: join(brokerRoot, "out.mp3") }, t);
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
			else process.env.PI_SPEAK_CONFIG_DIR = previousConfigDir;
			if (previousUserprofile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserprofile;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(brokerRoot, { recursive: true, force: true });
			rmSync(userRoot, { recursive: true, force: true });
		}
	};
}

/** Isolated env with no pre-existing sentinel, for the disable-write path. */
function withCleanSpeechEnv(callback) {
	return async (t) => {
		const previousConfigDir = process.env.PI_SPEAK_CONFIG_DIR;
		const previousUserprofile = process.env.USERPROFILE;
		const previousHome = process.env.HOME;
		const brokerRoot = mkdtempSync(join(tmpdir(), "pk-speak-clean-broker-"));
		const userRoot = mkdtempSync(join(tmpdir(), "pk-speak-clean-user-"));
		const configDir = join(brokerRoot, "pi-speak");
		mkdirSync(configDir, { recursive: true });
		const env = {
			...process.env,
			PI_SPEAK_CONFIG_DIR: configDir,
			USERPROFILE: userRoot,
			HOME: userRoot,
		};
		try {
			await callback({ env, disablePath: join(configDir, "voice-disabled") }, t);
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
			else process.env.PI_SPEAK_CONFIG_DIR = previousConfigDir;
			if (previousUserprofile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserprofile;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(brokerRoot, { recursive: true, force: true });
			rmSync(userRoot, { recursive: true, force: true });
		}
	};
}

test("pk-speak speak honors the disable sentinel: no synthesis, no orb, clear message", withDisabledSpeechEnv(async ({ env, outputPath }) => {
	const result = await runPkSpeak({
		env,
		args: ["speak", "--quiet", "--output", outputPath, "hello world"],
	});
	assert.equal(result.code, 0, `pk-speak should exit cleanly when disabled; stderr was:\n${result.stderr}`);
	assert.match(result.stderr, /speech is disabled/i);
	assert.ok(!existsSync(outputPath), "disable must abort before synthesis — no audio file should exist");
}));

test("disable sentinel survives a normal-mode (no --no-play) invocation without producing audio", withDisabledSpeechEnv(async ({ env, outputPath }) => {
	const result = await runPkSpeak({
		env,
		args: ["speak", "--output", outputPath, "hello world"],
	});
	assert.equal(result.code, 0);
	assert.ok(!existsSync(outputPath), "default-mode invocation must also honor the disable sentinel");
}));

test("pk-speak enable clears a pre-existing disable sentinel", withDisabledSpeechEnv(async ({ env, disablePath }) => {
	const result = await runPkSpeak({ env, args: ["enable"] });
	assert.equal(result.code, 0);
	assert.match(result.stdout, /speech re-enabled/i);
	assert.ok(!existsSync(disablePath), "enable must unlink the sentinel file");
}));

test("pk-speak enable is idempotent when speech is already enabled", withCleanSpeechEnv(async ({ env }) => {
	const result = await runPkSpeak({ env, args: ["enable"] });
	assert.equal(result.code, 0);
	assert.match(result.stdout, /already enabled/i);
}));

test("pk-speak disable writes the sentinel and prints the re-enable hint", withCleanSpeechEnv(async ({ env, disablePath }) => {
	const result = await runPkSpeak({ env, args: ["disable"] });
	assert.equal(result.code, 0);
	assert.match(result.stdout, /speech disabled.*re-enable.*pk-speak enable/is);
	assert.ok(existsSync(disablePath), "disable must write the sentinel file");
}));

test("pk-speak disable is idempotent when speech is already disabled", withDisabledSpeechEnv(async ({ env }) => {
	const result = await runPkSpeak({ env, args: ["disable"] });
	assert.equal(result.code, 0);
	assert.match(result.stdout, /already disabled/i);
}));

test("pk-speak enable --help does not mutate state", withDisabledSpeechEnv(async ({ env, disablePath }) => {
	const result = await runPkSpeak({ env, args: ["enable", "--help"] });
	assert.equal(result.code, 0);
	assert.match(result.stdout, /usage: pk-speak enable/i);
	assert.ok(existsSync(disablePath), "--help must not clear the sentinel");
}));

test("pk-speak disable --help does not mutate state", withCleanSpeechEnv(async ({ env, disablePath }) => {
	const result = await runPkSpeak({ env, args: ["disable", "--help"] });
	assert.equal(result.code, 0);
	assert.match(result.stdout, /usage: pk-speak disable/i);
	assert.ok(!existsSync(disablePath), "--help must not write the sentinel");
}));
