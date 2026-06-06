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

test("higgs provider is available only when reference audio is configured", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-higgs-"));
	const referencePath = join(tempDir, "reference.wav");
	try {
		await writeFile(referencePath, Buffer.from([0, 1, 2, 3]));
		await withEnv({
			PI_SPEAK_TTS_PROVIDER: "higgs",
			PI_SPEAK_HIGGS_REFERENCE_AUDIO: undefined,
		}, async () => {
			assert.notEqual(tts.resolveTtsProvider(), "higgs");
		});

		await withEnv({
			PI_SPEAK_TTS_PROVIDER: "higgs",
			PI_SPEAK_HIGGS_REFERENCE_AUDIO: referencePath,
		}, async () => {
			assert.equal(tts.resolveTtsProvider(), "higgs");
			const diagnostics = tts.getTtsDiagnostics();
			assert.equal(diagnostics.providers.higgs.available, true);
			assert.equal(diagnostics.providers.higgs.referenceAudioConfigured, true);
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("higgs writes speech through the gradio provider hook", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-higgs-synth-"));
	const referencePath = join(tempDir, "reference.wav");
	const outputPath = join(tempDir, "higgs.mp3");
	let seenText = "";
	try {
		await writeFile(referencePath, Buffer.from([0, 1, 2, 3]));
		tts.testOverrides.synthesizeHiggs = async (text, path) => {
			seenText = text;
			await writeFile(path, "higgs audio");
		};
		await withEnv({
			PI_SPEAK_TTS_PROVIDER: "higgs",
			PI_SPEAK_HIGGS_REFERENCE_AUDIO: referencePath,
			PI_SPEAK_REWRITE_ENABLED: "off",
			PI_SPEAK_SANITIZE: "off",
		}, async () => {
			const result = await tts.synthesizeToFile({
				text: "spoken by higgs",
				outputPath,
				state: { provider: "higgs", rewriteEnabled: false },
			});
			assert.equal(result.provider, "higgs");
			assert.equal(seenText, "spoken by higgs");
			assert.equal(await readFile(outputPath, "utf8"), "higgs audio");
		});
	} finally {
		tts.testOverrides.synthesizeHiggs = null;
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("stable-audio writes generated prompt audio through the gradio provider hook", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-stable-audio-"));
	const outputPath = join(tempDir, "stable.mp3");
	let seenPrompt = "";
	try {
		tts.testOverrides.synthesizeStableAudio = async (text, path) => {
			seenPrompt = text;
			await writeFile(path, "stable audio");
		};
		await withEnv({
			PI_SPEAK_TTS_PROVIDER: "stable-audio",
			PI_SPEAK_REWRITE_ENABLED: "off",
			PI_SPEAK_SANITIZE: "off",
		}, async () => {
			const result = await tts.synthesizeToFile({
				text: "short alert sound",
				outputPath,
				state: { provider: "stable-audio", rewriteEnabled: false },
			});
			assert.equal(result.provider, "stable-audio");
			assert.equal(seenPrompt, "short alert sound");
			assert.equal(await readFile(outputPath, "utf8"), "stable audio");
			assert.equal(tts.getTtsDiagnostics().providers.stableAudio.available, true);
		});
	} finally {
		tts.testOverrides.synthesizeStableAudio = null;
		await rm(tempDir, { recursive: true, force: true });
	}
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
