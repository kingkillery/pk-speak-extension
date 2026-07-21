#!/usr/bin/env node
/**
 * Benchmark pk-speak STT providers (transcribeAudioBuffer).
 *
 * Mirrors speech-to-speech scripts/benchmark_stt.py: stdout table + JSON output,
 * with --dry-run that validates the audio path and prints the plan without decoding.
 *
 * Usage:
 *   node dist/scripts/benchmark-stt.js --help
 *   node dist/scripts/benchmark-stt.js --dry-run --audio-file sample.wav
 *   node dist/scripts/benchmark-stt.js --dry-run --audio-file sample.wav --providers google
 *   node dist/scripts/benchmark-stt.js --audio-file sample.wav --providers local --iterations 3
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import type { SttProvider } from "../stt.js";

const DEFAULT_OUTPUT = "stt_benchmark_results.json";
const DEFAULT_ITERATIONS = 5;
const DEFAULT_PROVIDERS = ["local", "openai", "elevenlabs"] as const;

type BenchmarkSttProvider = Exclude<SttProvider, "auto">;

const VALID_PROVIDERS: Record<BenchmarkSttProvider, true> = {
	local: true,
	openai: true,
	elevenlabs: true,
	google: true,
};

type CliOptions = {
	help: boolean;
	dryRun: boolean;
	audioFile: string | null;
	providers: string[];
	iterations: number;
	output: string;
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
	total_iterations: number;
	sample_transcription: string | null;
	errors: string[];
	status?: undefined;
};

type Stats = FailedStats | SuccessStats;

class BenchmarkResult {
	providerName: string;
	warmupTime = 0;
	inferenceTimes: number[] = [];
	transcriptions: string[] = [];
	errors: string[] = [];

	constructor(providerName: string) {
		this.providerName = providerName;
	}

	addInference(timeTaken: number, transcription: string): void {
		this.inferenceTimes.push(timeTaken);
		this.transcriptions.push(transcription);
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
		return {
			provider: this.providerName,
			warmup_time: this.warmupTime,
			avg_inference_time: mean(this.inferenceTimes),
			min_inference_time: Math.min(...this.inferenceTimes),
			max_inference_time: Math.max(...this.inferenceTimes),
			std_inference_time: stdDev(this.inferenceTimes),
			total_iterations: this.inferenceTimes.length,
			sample_transcription: this.transcriptions[0] ?? null,
			errors: this.errors,
		};
	}
}

function printHelp(): void {
	console.log(`Usage: node dist/scripts/benchmark-stt.js [options]

Benchmark pk-speak STT providers via transcribeAudioBuffer.

Options:
  --audio-file <path>        Path to audio file (required; must exist even with --dry-run)
  --providers <names...>     Space-separated providers (default: local openai elevenlabs)
                             Valid: local openai elevenlabs google
  --iterations <n>           Iterations per provider (default: ${DEFAULT_ITERATIONS})
  --output <path>            JSON results path (default: ${DEFAULT_OUTPUT})
  --dry-run                  Validate inputs and print the plan without decoding audio or loading models
  --help, -h                 Show this help

Examples:
  node dist/scripts/benchmark-stt.js --dry-run --audio-file sample.wav
  node dist/scripts/benchmark-stt.js --dry-run --audio-file sample.wav --providers google
  node dist/scripts/benchmark-stt.js --audio-file sample.wav --providers local --iterations 3
`);
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		help: false,
		dryRun: false,
		audioFile: null,
		providers: [...DEFAULT_PROVIDERS],
		iterations: DEFAULT_ITERATIONS,
		output: DEFAULT_OUTPUT,
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
		if (arg === "--audio-file") {
			options.audioFile = requireValue(argv, ++i, "--audio-file");
			continue;
		}
		if (arg === "--output") {
			options.output = requireValue(argv, ++i, "--output");
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

function normalizeProviders(names: string[]): BenchmarkSttProvider[] {
	const out: BenchmarkSttProvider[] = [];
	const seen = new Set<BenchmarkSttProvider>();
	for (const raw of names) {
		const name = raw.trim().toLowerCase() as BenchmarkSttProvider;
		if (!VALID_PROVIDERS[name]) {
			throw new Error(`Unknown STT provider: ${raw}. Valid: ${Object.keys(VALID_PROVIDERS).join(", ")}`);
		}
		if (seen.has(name)) continue;
		seen.add(name);
		out.push(name);
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

/** Keep mime mapping aligned with stt.ts mimeTypeToExtension. */
function mimeTypeForAudioPath(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	switch (ext) {
		case ".wav":
			return "audio/wav";
		case ".mp3":
			return "audio/mpeg";
		case ".webm":
			return "audio/webm";
		case ".ogg":
			return "audio/ogg";
		case ".m4a":
			return "audio/mp4";
		default:
			return "application/octet-stream";
	}
}

function printResults(results: BenchmarkResult[]): void {
	console.log(`\n${"=".repeat(80)}`);
	console.log("BENCHMARK RESULTS");
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
		console.log(`\n  Total Iterations:     ${stats.total_iterations}`);
		console.log(`  Sample Transcription: ${stats.sample_transcription}`);
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
	meta: { audioFile: string; iterations: number },
): Promise<void> {
	const data = {
		results: results.map((result) => result.getStats()),
		timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
		audio_file: meta.audioFile,
		iterations: meta.iterations,
	};
	await writeFile(outputFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	console.log(`Results saved to: ${outputFile}`);
}

async function transcribeSelected(
	transcribeAudioBuffer: typeof import("../stt.js").transcribeAudioBuffer,
	provider: BenchmarkSttProvider,
	fileBuffer: Buffer,
	mimeType: string,
): Promise<string> {
	// Disable silent remote->local/OpenAI fallback so timings/errors reflect the selected provider.
	const transcription = await transcribeAudioBuffer(fileBuffer, mimeType, {
		allowProviderFallback: false,
	});
	if (transcription.provider !== provider) {
		throw new Error(
			`Requested STT provider '${provider}' but transcribeAudioBuffer used '${transcription.provider}'`,
		);
	}
	return transcription.text;
}

async function benchmarkProvider(
	provider: BenchmarkSttProvider,
	fileBuffer: Buffer,
	mimeType: string,
	iterations: number,
): Promise<BenchmarkResult> {
	const result = new BenchmarkResult(provider);
	console.log(`Benchmarking ${provider}...`);
	const previous = process.env.PI_SPEAK_REMOTE_STT_PROVIDER;
	process.env.PI_SPEAK_REMOTE_STT_PROVIDER = provider;
	let shutdownLocalSttWorker: undefined | (() => Promise<void>);
	try {
		const stt = await import("../stt.js");
		shutdownLocalSttWorker = stt.shutdownLocalSttWorker;
		const resolved = stt.resolveSttProvider();
		if (resolved !== provider) {
			throw new Error(
				`STT provider '${provider}' was not selected (resolveSttProvider returned '${resolved}')`,
			);
		}

		const warmupStart = performance.now();
		await transcribeSelected(stt.transcribeAudioBuffer, provider, fileBuffer, mimeType);
		result.warmupTime = (performance.now() - warmupStart) / 1000;
		console.log(`Provider ${provider} warmed up in ${result.warmupTime.toFixed(3)}s`);

		for (let i = 0; i < iterations; i += 1) {
			console.log(`Iteration ${i + 1}/${iterations} for ${provider}`);
			const start = performance.now();
			try {
				const text = await transcribeSelected(stt.transcribeAudioBuffer, provider, fileBuffer, mimeType);
				const timeTaken = (performance.now() - start) / 1000;
				result.addInference(timeTaken, text);
				const preview = text.slice(0, 50) || "(empty)";
				console.log(`  Time: ${timeTaken.toFixed(4)}s, Text: ${preview}...`);
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
		if (shutdownLocalSttWorker) {
			try {
				await shutdownLocalSttWorker();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.addError(`shutdownLocalSttWorker failed: ${message}`);
				console.error(`Cleanup error for ${provider}: ${message}`);
			}
		}
		if (previous === undefined) {
			delete process.env.PI_SPEAK_REMOTE_STT_PROVIDER;
		} else {
			process.env.PI_SPEAK_REMOTE_STT_PROVIDER = previous;
		}
	}
	return result;
}

function hasBenchmarkIssues(results: BenchmarkResult[], iterations: number): boolean {
	return results.some(
		(result) => result.errors.length > 0 || result.inferenceTimes.length < iterations,
	);
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

	if (!options.audioFile) {
		console.error("--audio-file is required");
		process.exitCode = 1;
		return;
	}

	let providers: BenchmarkSttProvider[];
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

	if (!existsSync(options.audioFile)) {
		console.error(`Audio file not found: ${options.audioFile}`);
		process.exitCode = 1;
		return;
	}

	if (options.dryRun) {
		console.log("Dry run: planned STT benchmark");
		console.log(`  Providers: ${providers.join(", ")}`);
		console.log(`  Iterations: ${options.iterations}`);
		console.log(`  Output: ${options.output}`);
		console.log(`  Audio file: ${options.audioFile}`);
		return;
	}

	const fileBuffer = await readFile(options.audioFile);
	const mimeType = mimeTypeForAudioPath(options.audioFile);
	console.log(`Audio loaded: ${fileBuffer.length} bytes (${mimeType}) from ${options.audioFile}`);

	const results: BenchmarkResult[] = [];
	for (const provider of providers) {
		results.push(await benchmarkProvider(provider, fileBuffer, mimeType, options.iterations));
	}

	printResults(results);
	await saveResults(results, options.output, {
		audioFile: options.audioFile,
		iterations: options.iterations,
	});
	if (hasBenchmarkIssues(results, options.iterations)) {
		process.exitCode = 1;
	}
	console.log("Benchmarking complete!");
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
