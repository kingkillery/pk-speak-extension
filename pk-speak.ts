#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export type PkSpeakArgs = {
	text?: string;
	voice?: string;
	play: boolean;
	wait: boolean;
	output?: string;
	rewrite: boolean;
	help: boolean;
	version: boolean;
};

export function parseArgs(argv: string[]): PkSpeakArgs {
	const args: PkSpeakArgs = {
		play: true,
		wait: true,
		rewrite: false,
		help: false,
		version: false,
	};
	const textParts: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--voice":
				args.voice = argv[++i];
				break;
			case "--output":
				args.output = argv[++i];
				break;
			case "--no-play":
				args.play = false;
				break;
			case "--no-wait":
				args.wait = false;
				break;
			case "--rewrite":
				args.rewrite = true;
				break;
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--version":
			case "-v":
				args.version = true;
				break;
			default:
				textParts.push(arg);
				break;
		}
	}
	const text = textParts.join(" ").trim();
	if (text) args.text = text;
	return args;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

const USAGE = `Usage: pk-speak [options] <text>

Speak text aloud using the configured pi-speak TTS provider.

Options:
  --voice <name>   Use a specific voice for the active provider.
  --no-play        Synthesize an audio file but do not play it.
  --no-wait        Start playback and return immediately (do not block).
  --output <path>  Write the audio file to <path> (default: a temp .mp3).
  --rewrite        Re-enable the speech-rewrite pass (off by default).
  -h, --help       Show this help and exit.
  -v, --version    Show the version and exit.

Examples:
  pk-speak "build is green and tests pass"
  pk-speak --voice nova "deploy finished"
  pk-speak --no-play --output reply.mp3 "saved for later"`;

function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		// dist/pk-speak.js -> repo root package.json is one level up from dist.
		const pkgPath = join(here, "..", "package.json");
		const raw = readFileSync(pkgPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version || "unknown";
	} catch {
		return "unknown";
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		process.exit(0);
	}
	if (args.version) {
		process.stdout.write(`${readPackageVersion()}\n`);
		process.exit(0);
	}
	if (!args.text) {
		process.stderr.write('pk-speak: missing text. Run "pk-speak --help" for usage.\n');
		process.exit(2);
	}

	// tts.ts evaluates its DEFAULT_* voice constants at module load, so the
	// voice override must be applied to the environment BEFORE importing it.
	if (args.voice) {
		process.env.PI_SPEAK_SAG_VOICE = args.voice;
		process.env.PI_SPEAK_ELEVENLABS_VOICE_ID = args.voice;
		process.env.PI_SPEAK_OPENAI_VOICE = args.voice;
		process.env.PI_SPEAK_EDGE_VOICE = args.voice;
	}

	try {
		const { synthesizeToFile } = await import("./tts.js");
		let outputPath = args.output;
		// When no --output is given we synthesize into a throwaway temp dir.
		// Track it so we can clean it up afterwards; user-supplied --output
		// paths are never touched.
		let tempAudioDir: string | undefined;
		if (!outputPath) {
			tempAudioDir = mkdtempSync(join(tmpdir(), "pk-speak-"));
			outputPath = join(tempAudioDir, "reply.mp3");
		}

		try {
			await synthesizeToFile({
				text: args.text,
				outputPath,
				state: { enabled: true, rewriteEnabled: args.rewrite },
			});

			if (!existsSync(outputPath)) {
				throw new Error("Speech synthesis did not create an audio file");
			}

			if (args.play) {
				const { playAudio } = await import("./audio-playback.js");
				await playAudio(outputPath, { wait: args.wait });
			}
		} finally {
			// Only auto-generated temp dirs are removed, on both success and
			// failure. Never delete a user-supplied --output path.
			if (tempAudioDir) {
				rmSync(tempAudioDir, { recursive: true, force: true });
			}
		}
	} catch (error) {
		process.stderr.write(`pk-speak: ${getErrorMessage(error)}\n`);
		process.exit(1);
	}
}

function isRunningAsBin(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		const modulePath = fileURLToPath(import.meta.url);
		if (modulePath === entry) return true;
		return realpathSync(modulePath) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isRunningAsBin()) {
	void main();
}
