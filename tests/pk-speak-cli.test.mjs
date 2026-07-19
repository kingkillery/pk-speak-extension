import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// parseArgs MUST be importable without running main() (the bin entrypoint).
const { parseArgs } = await import("../dist/pk-speak.js");

const BIN = "dist/pk-speak.js";

// Run the compiled CLI as a real bin. We pass a clean-ish env so the stub
// provider/keys can be controlled per-test, and never trigger real audio.
function runCli(args, extraEnv = {}) {
	return spawnSync(process.execPath, [BIN, ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
	});
}

// ---------------------------------------------------------------------------
// parseArgs unit tests (pure, no side effects)
// ---------------------------------------------------------------------------

test("parseArgs: plain text becomes the text and keeps defaults", () => {
	const args = parseArgs(["hello world"]);
	assert.equal(args.text, "hello world");
	assert.equal(args.play, true);
	assert.equal(args.wait, true);
	assert.equal(args.rewrite, false);
	assert.equal(args.help, false);
	assert.equal(args.version, false);
	assert.equal(args.voice, undefined);
	assert.equal(args.output, undefined);
});

test("parseArgs: multi-word non-flag args are joined by a space", () => {
	const args = parseArgs(["hello", "there", "operator"]);
	assert.equal(args.text, "hello there operator");
});

test("parseArgs: --voice <name> sets the voice", () => {
	const args = parseArgs(["--voice", "rachel", "say", "this"]);
	assert.equal(args.voice, "rachel");
	assert.equal(args.text, "say this");
});

test("parseArgs: --no-play disables playback", () => {
	const args = parseArgs(["--no-play", "quiet please"]);
	assert.equal(args.play, false);
	assert.equal(args.text, "quiet please");
});

test("parseArgs: --no-wait disables waiting", () => {
	const args = parseArgs(["--no-wait", "fire and forget"]);
	assert.equal(args.wait, false);
	assert.equal(args.text, "fire and forget");
});

test("parseArgs: --output <path> sets the output target", () => {
	const out = join(tmpdir(), "pk-speak-parse-output.mp3");
	const args = parseArgs(["--output", out, "render me"]);
	assert.equal(args.output, out);
	assert.equal(args.text, "render me");
});

test("parseArgs: --rewrite enables the rewrite pass", () => {
	const args = parseArgs(["--rewrite", "rewrite this"]);
	assert.equal(args.rewrite, true);
});

test("parseArgs: --help / -h set help", () => {
	assert.equal(parseArgs(["--help"]).help, true);
	assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: --version / -v set version", () => {
	assert.equal(parseArgs(["--version"]).version, true);
	assert.equal(parseArgs(["-v"]).version, true);
});

test("parseArgs: combined flags and text parse together", () => {
	const out = join(tmpdir(), "pk-speak-combined.mp3");
	const args = parseArgs(["--voice", "adam", "--no-play", "--rewrite", "--output", out, "all", "the", "things"]);
	assert.equal(args.voice, "adam");
	assert.equal(args.play, false);
	assert.equal(args.rewrite, true);
	assert.equal(args.output, out);
	assert.equal(args.text, "all the things");
});

test("parseArgs: no args yields no text but valid defaults", () => {
	const args = parseArgs([]);
	assert.equal(args.text === undefined || args.text === "", true);
	assert.equal(args.play, true);
	assert.equal(args.wait, true);
});

// ---------------------------------------------------------------------------
// CLI spawn tests (real bin behavior; hermetic, no network, no real audio)
// ---------------------------------------------------------------------------

test("CLI --help exits 0 and prints usage to stdout", () => {
	const result = runCli(["--help"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /pk-speak/i);
	assert.match(result.stdout, /usage/i);
});

test("CLI --version exits 0 and prints the package version", () => {
	const result = runCli(["--version"]);
	assert.equal(result.status, 0);
	// 0.x.y style semver from package.json.
	assert.match(result.stdout.trim(), /\d+\.\d+\.\d+/);
});

test("CLI with no text exits 2 with a one-line stderr error", () => {
	const result = runCli([]);
	assert.equal(result.status, 2);
	assert.notEqual(result.stderr.trim(), "");
	// One clean line, never a stack trace.
	const lines = result.stderr.trim().split(/\r?\n/).filter((line) => line.trim() !== "");
	assert.equal(lines.length, 1, `expected a single stderr line, got: ${JSON.stringify(result.stderr)}`);
	assert.doesNotMatch(result.stderr, /\bat\s+.*\(.*:\d+:\d+\)/);
});

test("CLI synth failure exits 1 with a clean one-line stderr (no stack, no secrets)", () => {
	const root = mkdtempSync(join(tmpdir(), "pk-speak-cli-"));
	const outputPath = join(root, "out.mp3");
	try {
		// Force the ElevenLabs provider with NO api key. synthesizeElevenLabs
		// throws "ELEVENLABS_API_KEY is required ..." BEFORE any fetch, so the
		// failure is fully offline/hermetic. --no-play avoids real audio.
		// Wipe every other provider/key so resolveTtsProvider cannot fall back
		// into a path that would actually synthesize (or hit the network).
		const result = runCli(
			["--no-play", "--output", outputPath, "please fail cleanly"],
			{
				PI_SPEAK_TTS_PROVIDER: "elevenlabs",
				ELEVENLABS_API_KEY: "",
				PI_SPEAK_SPEAK11_PATH: "",
				PI_SPEAK_OPENAI_KEY: "",
				VOICE_TOOLS_OPENAI_KEY: "",
				OPENROUTER_API_KEY: "",
			},
		);

		assert.equal(result.status, 1, `expected exit 1, stderr=${result.stderr}`);
		assert.notEqual(result.stderr.trim(), "");
		const lines = result.stderr.trim().split(/\r?\n/).filter((line) => line.trim() !== "");
		assert.equal(lines.length, 1, `expected a single stderr line, got: ${JSON.stringify(result.stderr)}`);
		// No raw stack trace.
		assert.doesNotMatch(result.stderr, /\bat\s+.*\(.*:\d+:\d+\)/);
		assert.doesNotMatch(result.stderr, /node:internal/);
		// On failure, no audio file should have been produced.
		assert.equal(existsSync(outputPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI never leaks the configured API key into stdout/stderr on failure", () => {
	const root = mkdtempSync(join(tmpdir(), "pk-speak-leak-"));
	const outputPath = join(root, "out.mp3");
	const secret = "test-key";
	try {
		// Use the sag provider with a stand-in binary (process.execPath) so the
		// availability check passes, but force failure by leaving the sag
		// pipeline unable to complete offline. The key is present in env to prove
		// it is never echoed into the agent-facing output. No real network call
		// to ElevenLabs is made because synthesizeSag spawns the local binary,
		// which (being process.execPath, not a real sag) exits non-zero offline.
		const result = runCli(
			["--no-play", "--output", outputPath, "secret check"],
			{
				PI_SPEAK_TTS_PROVIDER: "sag",
				PI_SPEAK_SAG_PATH: process.execPath,
				ELEVENLABS_API_KEY: secret,
				PI_SPEAK_REWRITE_ENABLED: "off",
				OPENROUTER_API_KEY: "",
			},
		);

		assert.notEqual(result.status, 0);
		assert.equal((result.stderr || "").includes(secret), false);
		assert.equal((result.stdout || "").includes(secret), false);
		assert.equal(existsSync(outputPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
