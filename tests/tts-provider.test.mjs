import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("edge provider can be selected from the bundled dependency", async () => {
	await withEnv({
		PI_SPEAK_TTS_PROVIDER: "edge",
	}, async () => {
		assert.equal(tts.resolveTtsProvider(), "edge");
	});
});

test("sanitizeForSpeech strips markdown, code, links, and emoji for every runtime", () => {
	const input = [
		"# Heading",
		"",
		"Here is **bold** and _italic_ and `inline code`.",
		"",
		"```js",
		"const x = 1;",
		"```",
		"",
		"- bullet one",
		"- bullet two",
		"",
		"See [the docs](https://example.com/docs) or visit https://example.com now. 🚀",
	].join("\n");
	const output = tts.sanitizeForSpeech(input);
	assert.equal(output.includes("#"), false);
	assert.equal(output.includes("**"), false);
	assert.equal(output.includes("`"), false);
	assert.equal(output.includes("const x = 1;"), false);
	assert.equal(output.includes("https://"), false);
	assert.equal(output.includes("🚀"), false);
	assert.equal(output.includes("- bullet"), false);
	assert.match(output, /code snippet/);
	assert.match(output, /the docs/);
	assert.match(output, /bold/);
	assert.match(output, /italic/);
	assert.match(output, /inline code/);
});

test("sanitizeForSpeech is idempotent on already-clean text", () => {
	const clean = "This is a plain spoken sentence with no markup.";
	assert.equal(tts.sanitizeForSpeech(clean), clean);
	assert.equal(tts.sanitizeForSpeech(tts.sanitizeForSpeech(clean)), clean);
});

test("sanitize can be disabled and is reflected in diagnostics", async () => {
	await withEnv({ PI_SPEAK_SANITIZE: undefined }, async () => {
		assert.equal(tts.isSanitizeEnabled(), true);
		assert.equal(tts.getTtsDiagnostics().sanitizeEnabled, true);
	});
	await withEnv({ PI_SPEAK_SANITIZE: "off" }, async () => {
		assert.equal(tts.isSanitizeEnabled(), false);
		assert.equal(tts.getTtsDiagnostics().sanitizeEnabled, false);
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

test("sag writes spoken text to stdin without including it in argv", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-sag-"));
	const previousCwd = process.cwd();
	const outputPath = join(tempDir, "capture.json");
	const spokenText = "spoken text sentinel that must only travel over stdin";
	const speakScript = [
		"import { writeFileSync } from 'node:fs';",
		"let stdin = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', chunk => { stdin += chunk; });",
		"process.stdin.on('end', () => {",
		"  const outputIndex = process.argv.indexOf('--output');",
		"  if (outputIndex < 0) throw new Error('missing --output');",
		"  writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ argv: process.argv.slice(2), stdin }));",
		"});",
	].join("\n");

	try {
		await writeFile(join(tempDir, "speak"), speakScript);
		process.chdir(tempDir);
		await withEnv({
			PI_SPEAK_TTS_PROVIDER: "sag",
			PI_SPEAK_SAG_PATH: process.execPath,
			PI_SPEAK_REWRITE_ENABLED: "off",
			PI_SPEAK_SANITIZE: "off",
			ELEVENLABS_API_KEY: "test-key",
		}, async () => {
			await tts.synthesizeToFile({
				text: spokenText,
				outputPath,
				state: { provider: "sag", rewriteEnabled: false },
			});
		});

		const capture = JSON.parse(await readFile(outputPath, "utf8"));
		assert.equal(capture.stdin, spokenText);
		assert.equal(capture.argv.includes(spokenText), false);
		assert.equal(JSON.stringify(capture.argv).includes(spokenText), false);
		assert.deepEqual(capture.argv.slice(-2), ["--output", outputPath]);
	} finally {
		process.chdir(previousCwd);
		await rm(tempDir, { recursive: true, force: true });
	}
});
