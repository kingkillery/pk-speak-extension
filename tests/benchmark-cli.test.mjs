import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TTS_SCRIPT = "dist/scripts/benchmark-tts.js";
const STT_SCRIPT = "dist/scripts/benchmark-stt.js";

/**
 * @param {string} script
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runBenchmark(script, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], {
			cwd: options.cwd ?? process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code, stdout, stderr });
		});
	});
}

async function pathExists(path) {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("benchmark-tts --help exits successfully with usage", async () => {
	const { code, stdout, stderr } = await runBenchmark(TTS_SCRIPT, ["--help"]);
	assert.equal(code, 0);
	assert.equal(stderr, "");
	assert.match(stdout, /Usage: node dist\/scripts\/benchmark-tts\.js/);
	assert.match(stdout, /--dry-run/);
	assert.match(stdout, /--providers/);
	assert.match(stdout, /--iterations/);
	assert.match(stdout, /--output/);
	assert.match(stdout, /--text/);
	assert.match(stdout, /--language-code/);
});

test("benchmark-stt --help exits successfully with usage", async () => {
	const { code, stdout, stderr } = await runBenchmark(STT_SCRIPT, ["--help"]);
	assert.equal(code, 0);
	assert.equal(stderr, "");
	assert.match(stdout, /Usage: node dist\/scripts\/benchmark-stt\.js/);
	assert.match(stdout, /--audio-file/);
	assert.match(stdout, /--dry-run/);
	assert.match(stdout, /--providers/);
	assert.match(stdout, /--iterations/);
	assert.match(stdout, /--output/);
});

test("benchmark-tts --dry-run prints the plan and does not write JSON", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "pi-speak-bench-tts-cli-"));
	const output = join(tmp, "tts_benchmark_results.json");
	try {
		const { code, stdout, stderr } = await runBenchmark(TTS_SCRIPT, [
			"--dry-run",
			"--text",
			"hello from cli test",
			"--providers",
			"edge",
			"--iterations",
			"2",
			"--language-code",
			"en",
			"--output",
			output,
		]);
		assert.equal(code, 0);
		assert.equal(stderr, "");
		assert.match(stdout, /Dry run: planned TTS benchmark/);
		assert.match(stdout, /Providers: edge/);
		assert.match(stdout, /Iterations: 2/);
		assert.match(stdout, /Language code: en/);
		assert.match(stdout, /Text: hello from cli test/);
		assert.match(stdout, new RegExp(`Output: ${escapeRegExp(output)}`));
		assert.equal(await pathExists(output), false);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("benchmark-stt --dry-run accepts an existing audio path and does not write JSON", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "pi-speak-bench-stt-cli-"));
	const audioFile = join(tmp, "sample.wav");
	const output = join(tmp, "stt_benchmark_results.json");
	await writeFile(audioFile, "not-real-audio-bytes", "utf8");
	try {
		const { code, stdout, stderr } = await runBenchmark(STT_SCRIPT, [
			"--dry-run",
			"--audio-file",
			audioFile,
			"--providers",
			"local",
			"--iterations",
			"1",
			"--output",
			output,
		]);
		assert.equal(code, 0);
		assert.equal(stderr, "");
		assert.match(stdout, /Dry run: planned STT benchmark/);
		assert.match(stdout, /Providers: local/);
		assert.match(stdout, /Iterations: 1/);
		assert.match(stdout, new RegExp(`Output: ${escapeRegExp(output)}`));
		assert.match(stdout, new RegExp(`Audio file: ${escapeRegExp(audioFile)}`));
		assert.doesNotMatch(stdout, /Audio loaded:/);
		assert.equal(await pathExists(output), false);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("benchmark CLIs reject malformed --iterations", async () => {
	const tts = await runBenchmark(TTS_SCRIPT, ["--dry-run", "--iterations", "0"]);
	assert.equal(tts.code, 1);
	assert.match(tts.stderr, /--iterations must be a positive integer \(got 0\)/);

	const stt = await runBenchmark(STT_SCRIPT, [
		"--dry-run",
		"--audio-file",
		"unused.wav",
		"--iterations",
		"nope",
	]);
	assert.equal(stt.code, 1);
	assert.match(stt.stderr, /--iterations must be a positive integer \(got nope\)/);
});

test("benchmark CLIs reject bare --providers", async () => {
	const tts = await runBenchmark(TTS_SCRIPT, ["--dry-run", "--providers"]);
	assert.equal(tts.code, 1);
	assert.match(tts.stderr, /--providers requires at least one provider name/);

	const stt = await runBenchmark(STT_SCRIPT, ["--dry-run", "--providers"]);
	assert.equal(stt.code, 1);
	assert.match(stt.stderr, /--providers requires at least one provider name/);
});

test("benchmark CLIs reject unknown providers", async () => {
	const tts = await runBenchmark(TTS_SCRIPT, ["--dry-run", "--providers", "not-a-provider"]);
	assert.equal(tts.code, 1);
	assert.match(tts.stderr, /Unknown TTS provider: not-a-provider/);

	const tmp = await mkdtemp(join(tmpdir(), "pi-speak-bench-stt-unknown-"));
	const audioFile = join(tmp, "sample.wav");
	await writeFile(audioFile, "x", "utf8");
	try {
		const stt = await runBenchmark(STT_SCRIPT, [
			"--dry-run",
			"--audio-file",
			audioFile,
			"--providers",
			"not-a-provider",
		]);
		assert.equal(stt.code, 1);
		assert.match(stt.stderr, /Unknown STT provider: not-a-provider/);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("benchmark-stt fails when --audio-file is missing or nonexistent", async () => {
	const missing = await runBenchmark(STT_SCRIPT, ["--dry-run", "--providers", "local"]);
	assert.equal(missing.code, 1);
	assert.match(missing.stderr, /--audio-file is required/);

	const tmp = await mkdtemp(join(tmpdir(), "pi-speak-bench-stt-missing-"));
	const missingPath = join(tmp, "does-not-exist.wav");
	try {
		const nonexistent = await runBenchmark(STT_SCRIPT, [
			"--dry-run",
			"--audio-file",
			missingPath,
			"--providers",
			"local",
		]);
		assert.equal(nonexistent.code, 1);
		assert.match(
			nonexistent.stderr,
			new RegExp(`Audio file not found: ${escapeRegExp(missingPath)}`),
		);
		assert.equal(await pathExists(missingPath), false);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});
