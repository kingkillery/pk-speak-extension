import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { applyPiSpeakSetupConfig, getPiSpeakSetupConfigPath, resolveTelegramBotToken, savePiSpeakSetupConfig, CURRENT_PI_SPEAK_CONFIG_SCHEMA_VERSION } = await import("../dist/setup-config.js");

/**
 * The interactive orb default shipped after this change must not be defeated by
 * setups persisted before it: those stored speakPlaybackGate="immediate"
 * (terminal auto-play), which is exactly the behavior the operator asked us to
 * stop shipping as the default. applyPiSpeakSetupConfig must force-upgrade the
 * legacy value to "orb" unless PI_SPEAK_PLAYBACK_GATE is explicitly set this
 * session.
 */
function loadConfigIntoEnv(config, env = {}) {
	const previous = process.env.PI_SPEAK_CONFIG_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pi-speak-setup-test-"));
	process.env.PI_SPEAK_CONFIG_DIR = dir;
	const envWithConfigDir = { ...env, PI_SPEAK_CONFIG_DIR: dir };
	try {
		writeFileSync(getPiSpeakSetupConfigPath(envWithConfigDir), JSON.stringify(config));
		return { env: applyPiSpeakSetupConfig(envWithConfigDir), cleanup() {
			if (previous === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
			else process.env.PI_SPEAK_CONFIG_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		} };
	} catch (err) {
		if (previous === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
		else process.env.PI_SPEAK_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
}

test("legacy persisted 'immediate' is migrated to 'orb' so existing installs stop auto-playing", () => {
	const { env, cleanup } = loadConfigIntoEnv({ speakPlaybackGate: "immediate" });
	try {
		assert.equal(env.PI_SPEAK_PLAYBACK_GATE, "orb", "legacy persisted immediate must upgrade to orb");
	} finally {
		cleanup();
	}
});

test("an explicit env override this session beats the migration", () => {
	const { env, cleanup } = loadConfigIntoEnv({ speakPlaybackGate: "immediate" }, { PI_SPEAK_PLAYBACK_GATE: "immediate" });
	try {
		assert.equal(env.PI_SPEAK_PLAYBACK_GATE, "immediate", "deliberate re-opt-in to immediate must win");
	} finally {
		cleanup();
	}
});

test("a non-legacy persisted gate (orb, enter) is preserved verbatim", () => {
	const orb = loadConfigIntoEnv({ speakPlaybackGate: "orb" });
	try { assert.equal(orb.env.PI_SPEAK_PLAYBACK_GATE, "orb"); } finally { orb.cleanup(); }
	const enter = loadConfigIntoEnv({ speakPlaybackGate: "enter" });
	try { assert.equal(enter.env.PI_SPEAK_PLAYBACK_GATE, "enter"); } finally { enter.cleanup(); }
});

test("a current-schema persisted 'immediate' is preserved (deliberate re-opt-in via setup)", () => {
	// Simulate the setup UI having been run against the current codebase and
	// the operator explicitly picking "immediate". The persisted config now
	// carries configSchemaVersion = CURRENT, so apply() must NOT rewrite it.
	const previous = process.env.PI_SPEAK_CONFIG_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pi-speak-schema-test-"));
	process.env.PI_SPEAK_CONFIG_DIR = dir;
	try {
		const configPath = getPiSpeakSetupConfigPath({ PI_SPEAK_CONFIG_DIR: dir });
		writeFileSync(configPath, JSON.stringify({
			speakPlaybackGate: "immediate",
			configSchemaVersion: CURRENT_PI_SPEAK_CONFIG_SCHEMA_VERSION,
		}));
		const env = applyPiSpeakSetupConfig({ PI_SPEAK_CONFIG_DIR: dir });
		assert.equal(env.PI_SPEAK_PLAYBACK_GATE, "immediate", "current-version deliberate immediate must be preserved");
	} finally {
		if (previous === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
		else process.env.PI_SPEAK_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a saved Telegram token resolves for the Telegram gateway without leaking its secret or pairing state into env", () => {
	const config = {
		telegramBotToken: "123456:telegram-test-token",
		phoneState: { linkCode: "123456", linkedChatId: "42" },
	};
	const { env, cleanup } = loadConfigIntoEnv(config);
	try {
		assert.equal(env.PI_SPEAK_TELEGRAM_BOT_TOKEN, undefined);
		assert.equal(resolveTelegramBotToken(env, config), "123456:telegram-test-token");
		assert.equal(env.linkCode, undefined);
		assert.equal(env.linkedChatId, undefined);
	} finally {
		cleanup();
	}
});

test("savePiSpeakSetupConfig stamps the current schema version", () => {
	const previous = process.env.PI_SPEAK_CONFIG_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pi-speak-save-version-test-"));
	process.env.PI_SPEAK_CONFIG_DIR = dir;
	try {
		savePiSpeakSetupConfig({ speakPlaybackGate: "immediate" }, { PI_SPEAK_CONFIG_DIR: dir });
		const saved = JSON.parse(readFileSync(getPiSpeakSetupConfigPath({ PI_SPEAK_CONFIG_DIR: dir }), "utf8"));
		assert.equal(saved.configSchemaVersion, CURRENT_PI_SPEAK_CONFIG_SCHEMA_VERSION);
		assert.equal(saved.speakPlaybackGate, "immediate");
		// Re-loaded through apply(): current version means no migration, so
		// the operator's explicit "immediate" survives.
		const env = applyPiSpeakSetupConfig({ PI_SPEAK_CONFIG_DIR: dir });
		assert.equal(env.PI_SPEAK_PLAYBACK_GATE, "immediate");
	} finally {
		if (previous === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
		else process.env.PI_SPEAK_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
