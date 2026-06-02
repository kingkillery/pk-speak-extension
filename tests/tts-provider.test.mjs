import test from "node:test";
import assert from "node:assert/strict";

const tts = await import("../dist/tts.js");

async function withEnv(patch, run) {
	const previous = {};
	for (const key of Object.keys(patch)) {
		previous[key] = process.env[key];
		const value = patch[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("sag provider is available only with sag and ElevenLabs auth", async () => {
	await withEnv({
		PI_SPEAK_TTS_PROVIDER: "sag",
		PI_SPEAK_SAG_PATH: "C:/definitely/missing/sag.exe",
		ELEVENLABS_API_KEY: "test-key",
	}, async () => {
		assert.notEqual(tts.resolveTtsProvider(), "sag");
	});

	await withEnv({
		PI_SPEAK_TTS_PROVIDER: "sag",
		PI_SPEAK_SAG_PATH: process.execPath,
		ELEVENLABS_API_KEY: undefined,
	}, async () => {
		assert.notEqual(tts.resolveTtsProvider(), "sag");
	});

	await withEnv({
		PI_SPEAK_TTS_PROVIDER: "sag",
		PI_SPEAK_SAG_PATH: process.execPath,
		ELEVENLABS_API_KEY: "test-key",
	}, async () => {
		assert.equal(tts.resolveTtsProvider(), "sag");
	});
});

test("sag diagnostics expose command and auth availability without secrets", async () => {
	await withEnv({
		PI_SPEAK_TTS_PROVIDER: "sag",
		PI_SPEAK_SAG_PATH: process.execPath,
		ELEVENLABS_API_KEY: "test-key",
	}, async () => {
		const diagnostics = tts.getTtsDiagnostics();
		assert.equal(diagnostics.resolvedProvider, "sag");
		assert.equal(diagnostics.providers.sag.available, true);
		assert.equal(diagnostics.providers.sag.authAvailable, true);
		assert.equal(diagnostics.providers.sag.command, process.execPath);
		assert.equal(JSON.stringify(diagnostics).includes("test-key"), false);
	});
});
