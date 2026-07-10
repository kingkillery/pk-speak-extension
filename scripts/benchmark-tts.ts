#!/usr/bin/env node
/**
 * Benchmark pk-speak TTS providers (synthesizeToFile).
 *
 * Mirrors speech-to-speech scripts/benchmark_tts.py: stdout table + JSON output,
 * with --dry-run that prints the plan without synthesizing.
 *
 * Usage:
 *   node dist/scripts/benchmark-tts.js --help
 *   node dist/scripts/benchmark-tts.js --dry-run --text "hello"
 *   node dist/scripts/benchmark-tts.js --text "hello" --providers edge --iterations 3
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TtsProvider } from "../tts.js";

const DEFAULT_TEXT = "Hello from the pk-speak TTS benchmark. This is a latency test.";
const DEFAULT_OUTPUT = "tts_benchmark_results.json";
const DEFAULT_ITERATIONS = 3;
const DEFAULT_LANGUAGE_CODE = "en";
const DEFAULT_PROVIDERS = ["edge"] as const;

type BenchmarkTtsProvider = Exclude<TtsProvider, "auto">;

const VALID_PROVIDERS = new Set<BenchmarkTtsProvider>([
	"edge",
	"gemini",
	"openai",
	"elevenlabs",
	"sag",
	"higgs",
	"stable-audio",
	"minimax",
	"legacy",
]);

type CliOptions = {
	help: boolean;
	dryRun: boolean;
	text: string;
	providers: string[];
	iterations: number;
	output: string;
	languageCode: string;
};

type FailedStats = {
	provider: string;
	status: "failed";
	errors: string[];
};

type SuccessStats = {
	provider: string;
	warmup_time: number;
	avg_inference_time: number;
	min_inference_time: number;
	max_inference_time: number;
	std_inference_time: number;
	avg_audio_duration: number;
	min_audio_duration: number;
	max_audio_duration: number;
	std_audio_duration: number;
	avg_rtf: number;
	total_iterations: number;
	errors: string[];
	status?: undefined;
};

type Stats = FailedStats | SuccessStats;

class BenchmarkResult {
	providerName: string;
	warmupTime = 0;
	inferenceTimes: number[] = [];
	audioDurations: number[] = [];
	errors: string[] = [];

	constructor(providerName: string) {
		this.providerName = providerName;
	}

	addInference(timeTaken: number, audioDuration: number): void {
		this.inferenceTimes.push(timeTaken);
		this.audioDurations.push(audioDuration);
	}

	addError(error: string): void {
		this.errors.push(error);
	}

	getStats(): Stats {
		if (this.inferenceTimes.length === 0) {
			return {
				provider: this.providerName,
				status: "failed",
				errors: this.errors,
			};
		}
		const avgTime = mean(this.inferenceTimes);
		const avgAudio = mean(this.audioDurations);
		const avgRtf = avgTime > 0 ? avgAudio / avgTime : 0;
		return {
			provider: this.providerName,
			warmup_time: this.warmupTime,
			avg_inference_time: avgTime,
			min_inference_time: Math.min(...this.inferenceTimes),
			max_inference_time: Math.max(...this.inferenceTimes),
			std_inference_time: stdDev(this.inferenceTimes),
			avg_audio_duration: avgAudio,
			min_audio_duration: Math.min(...this.audioDurations),
			max_audio_duration: Math.max(...this.audioDurations),
			std_audio_duration: stdDev(this.audioDurations),
			avg_rtf: avgRtf,
			total_iterations: this.inferenceTimes.length,
			errors: this.errors,
		};
	}
}

function printHelp(): void {
	console.log(`Usage: node dist/scripts/benchmark-tts.js [options]

Benchmark pk-speak TTS providers via synthesizeToFile.

Options:
  --text <text>              Text to synthesize (default: sample sentence)
  --providers <names...>     Space-separated providers (default: edge)
                             Valid: edge gemini openai elevenlabs sag higgs stable-audio minimax legacy
  --iterations <n>           Iterations per provider (default: ${DEFAULT_ITERATIONS})
  --output <path>            JSON results path (default: ${DEFAULT_OUTPUT})
  --language-code <code>     Language code recorded in the plan/results (default: ${DEFAULT_LANGUAGE_CODE})
  --dry-run                  Print the planned benchmark without synthesizing
  --help, -h                 Show this help

Examples:
  node dist/scripts/benchmark-tts.js --dry-run --text "hello"
  node dist/scripts/benchmark-tts.js --text "hello" --providers edge openai --iterations 3
`);
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		help: false,
		dryRun: false,
		text: DEFAULT_TEXT,
		providers: [...DEFAULT_PROVIDERS],
		iterations: DEFAULT_ITERATIONS,
		output: DEFAULT_OUTPUT,
		languageCode: DEFAULT_LANGUAGE_CODE,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--text") {
			options.text = requireValue(argv, ++i, "--text");
			continue;
		}
		if (arg === "--output") {
			options.output = requireValue(argv, ++i, "--output");
			continue;
		}
		if (arg === "--language-code") {
			options.languageCode = requireValue(argv, ++i, "--language-code");
			continue;
		}
		if (arg === "--iterations") {
			const raw = requireValue(argv, ++i, "--iterations");
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed) || parsed < 1) {
				throw new Error(`--iterations must be a positive integer (got ${raw})`);
			}
			options.iterations = parsed;
			continue;
		}
		if (arg === "--providers") {
			const names: string[] = [];
			while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
				names.push(argv[++i]!);
			}
			if (names.length === 0) {
				throw new Error("--providers requires at least one provider name");
			}
			options.providers = names;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function normalizeProviders(names: string[]): BenchmarkTtsProvider[] {
	const out: BenchmarkTtsProvider[] = [];
	for (const raw of names) {
		const name = raw.trim().toLowerCase();
		if (!VALID_PROVIDERS.has(name as BenchmarkTtsProvider)) {
			throw new Error(`Unknown TTS provider: ${raw}. Valid: ${[...VALID_PROVIDERS].join(", ")}`);
		}
		out.push(name as BenchmarkTtsProvider);
	}
	return out;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
	if (values.length === 0) return 0;
	const avg = mean(values);
	const variance = mean(values.map((value) => (value - avg) ** 2));
	return Math.sqrt(variance);
}

/** Match synthesizeToFile output formats so path-based tools and mime helpers stay accurate. */
function extensionForProvider(provider: BenchmarkTtsProvider): string {
	switch (provider) {
		case "gemini":
		case "higgs":
		case "stable-audio":
		case "legacy":
			return ".wav";
		default:
			return ".mp3";
	}
}

function estimateWavDurationSeconds(buffer: Buffer): number {
	if (buffer.length < 44) return 0;
	const riff = buffer.subarray(0, 4).toString("ascii");
	const wave = buffer.subarray(8, 12).toString("ascii");
	if (riff !== "RIFF" || wave !== "WAVE") return 0;
	const byteRate = buffer.readUInt32LE(28);
	if (byteRate <= 0) return 0;
	return Math.max(0, (buffer.length - 44) / byteRate);
}

function skipId3(buffer: Buffer): number {
	if (buffer.length < 10) return 0;
	if (buffer.subarray(0, 3).toString("ascii") !== "ID3") return 0;
	const size =
		((buffer[6]! & 0x7f) << 21) |
		((buffer[7]! & 0x7f) << 14) |
		((buffer[8]! & 0x7f) << 7) |
		(buffer[9]! & 0x7f);
	return Math.min(buffer.length, 10 + size);
}

function estimateMp3DurationSeconds(buffer: Buffer): number {
	let offset = skipId3(buffer);
	let duration = 0;
	let frames = 0;
	const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
	const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
	const mpeg1Rates = [44100, 48000, 32000, 0];
	const mpeg2Rates = [22050, 24000, 16000, 0];
	const mpeg25Rates = [11025, 12000, 8000, 0];

	while (offset + 4 < buffer.length && frames < 20000) {
		if (buffer[offset] !== 0xff || (buffer[offset + 1]! & 0xe0) !== 0xe0) {
			offset += 1;
			continue;
		}
		const b1 = buffer[offset + 1]!;
		const b2 = buffer[offset + 2]!;
		const versionBits = (b1 >> 3) & 0x03;
		const layerBits = (b1 >> 1) & 0x03;
		if (versionBits === 1 || layerBits !== 1) {
			offset += 1;
			continue;
		}
		const bitrateIndex = (b2 >> 4) & 0x0f;
		const sampleRateIndex = (b2 >> 2) & 0x03;
		const padding = (b2 >> 1) & 0x01;
		const isMpeg1 = versionBits === 3;
		const isMpeg25 = versionBits === 0;
		const bitrates = isMpeg1 ? mpeg1Bitrates : mpeg2Bitrates;
		const sampleRates = isMpeg1 ? mpeg1Rates : isMpeg25 ? mpeg25Rates : mpeg2Rates;
		const bitrate = bitrates[bitrateIndex] ?? 0;
		const sampleRate = sampleRates[sampleRateIndex] ?? 0;
		if (bitrate <= 0 || sampleRate <= 0) {
			offset += 1;
			continue;
		}
		const samplesPerFrame = isMpeg1 ? 1152 : 576;
		const frameLength = Math.floor((samplesPerFrame / 8 * bitrate * 1000) / sampleRate) + padding;
		if (frameLength < 4 || offset + frameLength > buffer.length) {
			offset += 1;
			continue;
		}
		duration += samplesPerFrame / sampleRate;
		frames += 1;
		offset += frameLength;
	}
	return frames > 0 ? duration : 0;
}

function estimateAudioDurationSeconds(buffer: Buffer): number {
	const wav = estimateWavDurationSeconds(buffer);
	if (wav > 0) return wav;
	return estimateMp3DurationSeconds(buffer);
}

function printResults(results: BenchmarkResult[]): void {
	console.log(`\n${"=".repeat(80)}`);
	console.log("TTS BENCHMARK RESULTS");
	console.log("=".repeat(80));

	for (const result of results) {
		const stats = result.getStats();
		console.log(`\nProvider: ${stats.provider}`);
		console.log("-".repeat(80));
		if (stats.status === "failed") {
			console.log("  Status: FAILED");
			console.log(`  Errors: ${JSON.stringify(stats.errors)}`);
			continue;
		}
		console.log(`  Warmup Time:          ${stats.warmup_time.toFixed(4)}s`);
		console.log(`  Avg Inference Time:   ${stats.avg_inference_time.toFixed(4)}s`);
		console.log(`  Min Inference Time:   ${stats.min_inference_time.toFixed(4)}s`);
		console.log(`  Max Inference Time:   ${stats.max_inference_time.toFixed(4)}s`);
		console.log(`  Std Deviation:        ${stats.std_inference_time.toFixed(4)}s`);
		console.log(`  Avg Audio Duration:   ${stats.avg_audio_duration.toFixed(2)}s`);
		console.log(`  Min Audio Duration:   ${stats.min_audio_duration.toFixed(2)}s`);
		console.log(`  Max Audio Duration:   ${stats.max_audio_duration.toFixed(2)}s`);
		console.log(`  Std Audio Duration:   ${stats.std_audio_duration.toFixed(4)}s`);
		console.log(`  Avg RTF:              ${stats.avg_rtf.toFixed(2)}`);
		console.log(`\n  Total Iterations:     ${stats.total_iterations}`);
		if (stats.errors.length > 0) {
			console.log(`  Errors: ${JSON.stringify(stats.errors)}`);
		}
	}

	console.log(`\n${"=".repeat(80)}`);
	console.log("COMPARISON (Average Inference Time)");
	console.log("=".repeat(80));
	const successful = results.filter((result) => result.inferenceTimes.length > 0);
	if (successful.length === 0) return;
	const sorted = [...successful].sort((a, b) => mean(a.inferenceTimes) - mean(b.inferenceTimes));
	const fastestTime = mean(sorted[0]!.inferenceTimes);
	for (const result of sorted) {
		const avgTime = mean(result.inferenceTimes);
		const slower = fastestTime > 0 ? avgTime / fastestTime : 0;
		console.log(`  ${result.providerName.padEnd(25)}: ${avgTime.toFixed(4)}s  (${slower.toFixed(2)}x slower than fastest)`);
	}
}

async function saveResults(
	results: BenchmarkResult[],
	outputFile: string,
	meta: { text: string; languageCode: string; iterations: number },
): Promise<void> {
	const data = {
		results: results.map((result) => result.getStats()),
		timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
		text: meta.text,
		language_code: meta.languageCode,
		iterations: meta.iterations,
	};
	await writeFile(outputFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	console.log(`Results saved to: ${outputFile}`);
}

async function synthesizeSelected(
	synthesizeToFile: typeof import("../tts.js").synthesizeToFile,
	provider: BenchmarkTtsProvider,
	text: string,
	outputPath: string,
): Promise<void> {
	const synthesis = await synthesizeToFile({
		text,
		outputPath,
		// Force the requested provider path and exclude rewrite latency from provider timings.
		state: { provider, rewriteEnabled: false },
	});
	if (synthesis.provider !== provider) {
		throw new Error(
			`Requested TTS provider '${provider}' but synthesizeToFile used '${synthesis.provider}' (unavailable or fell back)`,
		);
	}
}

async function benchmarkProvider(
	provider: BenchmarkTtsProvider,
	text: string,
	iterations: number,
): Promise<BenchmarkResult> {
	const result = new BenchmarkResult(provider);
	console.log(`Benchmarking ${provider}...`);
	const tempRoot = await mkdtemp(join(tmpdir(), "pk-speak-bench-tts-"));
	try {
		const warmupStart = performance.now();
		const { synthesizeToFile, resolveTtsProvider } = await import("../tts.js");
		const resolved = resolveTtsProvider({ provider, rewriteEnabled: false });
		if (resolved !== provider) {
			throw new Error(
				`TTS provider '${provider}' is not available (resolveTtsProvider selected '${resolved}')`,
			);
		}

		const warmupPath = join(tempRoot, `${provider}-warmup${extensionForProvider(provider)}`);
		await synthesizeSelected(synthesizeToFile, provider, text, warmupPath);
		result.warmupTime = (performance.now() - warmupStart) / 1000;
		console.log(`Provider ${provider} warmed up in ${result.warmupTime.toFixed(3)}s`);

		for (let i = 0; i < iterations; i += 1) {
			console.log(`Iteration ${i + 1}/${iterations} for ${provider}`);
			const outputPath = join(tempRoot, `${provider}-${i}${extensionForProvider(provider)}`);
			const start = performance.now();
			try {
				await synthesizeSelected(synthesizeToFile, provider, text, outputPath);
				const timeTaken = (performance.now() - start) / 1000;
				const buffer = await readFile(outputPath);
				const audioDuration = estimateAudioDurationSeconds(buffer);
				result.addInference(timeTaken, audioDuration);
				const rtf = timeTaken > 0 ? audioDuration / timeTaken : 0;
				console.log(`  Time: ${timeTaken.toFixed(4)}s, Audio: ${audioDuration.toFixed(2)}s, RTF: ${rtf.toFixed(2)}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.addError(message);
				console.error(`  Error: ${message}`);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result.addError(message);
		console.error(`Error benchmarking ${provider}: ${message}`);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
	return result;
}

function anyProviderFailed(results: BenchmarkResult[]): boolean {
	return results.some((result) => result.inferenceTimes.length === 0);
}

async function main(): Promise<void> {
	let options: CliOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	if (options.help) {
		printHelp();
		return;
	}

	let providers: BenchmarkTtsProvider[];
	try {
		providers = normalizeProviders(options.providers);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	if (providers.length === 0) {
		console.error("No providers provided");
		process.exitCode = 1;
		return;
	}

	if (options.dryRun) {
		console.log("Dry run: planned TTS benchmark");
		console.log(`  Providers: ${providers.join(", ")}`);
		console.log(`  Iterations: ${options.iterations}`);
		console.log(`  Output: ${options.output}`);
		console.log(`  Language code: ${options.languageCode}`);
		console.log(`  Text: ${options.text}`);
		return;
	}

	const results: BenchmarkResult[] = [];
	for (const provider of providers) {
		results.push(await benchmarkProvider(provider, options.text, options.iterations));
	}

	printResults(results);
	await saveResults(results, options.output, {
		text: options.text,
		languageCode: options.languageCode,
		iterations: options.iterations,
	});
	if (anyProviderFailed(results)) {
		process.exitCode = 1;
	}
	console.log("TTS benchmarking complete!");
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
