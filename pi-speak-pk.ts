#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getPiSpeakSetupConfigPath,
	loadPiSpeakSetupConfig,
	maskSecret,
	savePiSpeakSetupConfig,
	type PiSpeakSetupConfig,
} from "./setup-config.js";
import { describeSpeakPlaybackGate, normalizeSpeakPlaybackGate } from "./speak-gate.js";

type Args = Record<string, string | boolean>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const command = String(args._ || args.command || "setup");
	if (args.help || args.h || command === "help") {
		printHelp();
		return;
	}
	if (args["print-config-path"]) {
		console.log(getPiSpeakSetupConfigPath());
		return;
	}
	if (command === "doctor") {
		printDoctor();
		return;
	}
	if (command !== "setup" && command !== "init") {
		console.error(`Unknown command: ${command}`);
		printHelp();
		process.exitCode = 1;
		return;
	}
	await runSetup(args);
}

async function runSetup(args: Args) {
	const existing = loadPiSpeakSetupConfig();
	const config: PiSpeakSetupConfig = { ...existing };
	const yes = !!args.yes || !!args.y;
	const dryRun = !!args["dry-run"];
	const nonInteractive = !!args["non-interactive"] || !process.stdin.isTTY;
	const rl = nonInteractive || yes ? undefined : createInterface({ input, output });
	try {
		console.log("Pi Speak setup");
		console.log("This writes a local setup profile used by pk-speak, pi-speak-gateway, and pi-speak-tray.");
		console.log("");
		config.agentProvider = await choice(rl, {
			label: "Coding agent backend",
			current: config.agentProvider,
			defaultValue: valueArg(args.provider) || valueArg(args.agent) || "codex",
			choices: ["codex", "claude", "pi"],
			yes,
			nonInteractive,
		});
		config.executionRouterMode = await choice(rl, {
			label: "Voice router mode",
			current: config.executionRouterMode,
			defaultValue: valueArg(args.router) || "auto",
			choices: ["auto", "codex", "claude", "pi"],
			yes,
			nonInteractive,
		});
		config.ttsProvider = await choice(rl, {
			label: "Reply voice provider",
			current: config.ttsProvider,
			defaultValue: valueArg(args.tts) || "edge",
			choices: ["edge", "elevenlabs", "openai", "sag", "auto"],
			yes,
			nonInteractive,
		});
		config.speakPlaybackGate = await choice(rl, {
			label: "Spoken playback gate",
			current: config.speakPlaybackGate,
			defaultValue: valueArg(args.gate || args["speak-gate"]) || "immediate",
			choices: ["immediate", "enter"],
			yes,
			nonInteractive,
		});
		if (config.ttsProvider === "elevenlabs" || config.ttsProvider === "sag") {
			config.elevenLabsApiKey = await secret(rl, {
				label: "ElevenLabs API key",
				current: config.elevenLabsApiKey,
				argValue: valueArg(args.elevenlabsKey || args["elevenlabs-key"]),
				yes,
				nonInteractive,
			});
			config.elevenLabsVoiceId = await text(rl, {
				label: "ElevenLabs voice id",
				current: config.elevenLabsVoiceId,
				defaultValue: valueArg(args.voice) || "pNInz6obpgDQGcFmaJgB",
				yes,
				nonInteractive,
			});
			config.elevenLabsModelId = await text(rl, {
				label: "ElevenLabs model id",
				current: config.elevenLabsModelId,
				defaultValue: valueArg(args.elevenlabsModel || args["elevenlabs-model"]) || "eleven_multilingual_v2",
				yes,
				nonInteractive,
			});
		}
		if (config.ttsProvider === "openai") {
			config.openAiKey = await secret(rl, {
				label: "OpenAI audio API key",
				current: config.openAiKey,
				argValue: valueArg(args.openaiKey || args["openai-key"]),
				yes,
				nonInteractive,
			});
			config.openAiTtsModel = await text(rl, {
				label: "OpenAI TTS model",
				current: config.openAiTtsModel,
				defaultValue: "gpt-4o-mini-tts",
				yes,
				nonInteractive,
			});
			config.openAiVoice = await text(rl, {
				label: "OpenAI voice",
				current: config.openAiVoice,
				defaultValue: "alloy",
				yes,
				nonInteractive,
			});
		}
		config.remoteSttProvider = await choice(rl, {
			label: "Phone voice transcription",
			current: config.remoteSttProvider,
			defaultValue: valueArg(args.stt) || "auto",
			choices: ["auto", "local", "openai"],
			yes,
			nonInteractive,
		});
		config.httpPort = await text(rl, {
			label: "Gateway HTTP port",
			current: config.httpPort,
			defaultValue: valueArg(args.port) || "8767",
			yes,
			nonInteractive,
		});
		config.httpToken = await secret(rl, {
			label: "Gateway pairing token",
			current: config.httpToken,
			argValue: valueArg(args.token),
			defaultValue: randomBytes(32).toString("base64url"),
			yes,
			nonInteractive,
		});
		config.installMobileApp = await bool(rl, {
			label: "Also set up the Android app",
			current: config.installMobileApp,
			defaultValue: boolArg(args.mobile) ?? true,
			yes,
			nonInteractive,
		});
		config.preferTray = await bool(rl, {
			label: "Start with the Windows tray controller when available",
			current: config.preferTray,
			defaultValue: boolArg(args.tray) ?? true,
			yes,
			nonInteractive,
		});
		if (dryRun) {
			printConfigSummary(config, "Dry run; no file written.");
			return;
		}
		const path = savePiSpeakSetupConfig(config);
		printConfigSummary(config, `Saved setup to ${path}`);
		printNextSteps(config);
	} finally {
		rl?.close();
	}
}

function printConfigSummary(config: PiSpeakSetupConfig, heading: string) {
	console.log("");
	console.log(heading);
	console.log(`Agent: ${config.agentProvider || "codex"}`);
	console.log(`Voice router: ${config.executionRouterMode || "auto"}`);
	console.log(`TTS: ${config.ttsProvider || "edge"}`);
	console.log(`Playback gate: ${describeSpeakPlaybackGate(normalizeSpeakPlaybackGate(config.speakPlaybackGate) || "immediate")}`);
	if (config.elevenLabsApiKey) console.log(`ElevenLabs key: ${maskSecret(config.elevenLabsApiKey)}`);
	if (config.openAiKey) console.log(`OpenAI audio key: ${maskSecret(config.openAiKey)}`);
	console.log(`STT: ${config.remoteSttProvider || "auto"}`);
	console.log(`Port: ${config.httpPort || "8767"}`);
	console.log(`Mobile app setup: ${config.installMobileApp ? "yes" : "no"}`);
}

function printNextSteps(config: PiSpeakSetupConfig) {
	console.log("");
	console.log("Next commands:");
	console.log("  pk-speak doctor");
	console.log(config.preferTray ? "  pk-speak tray" : "  pk-speak gateway");
	if (config.installMobileApp) console.log("  pk-speak mobile");
	console.log("");
	console.log("Inside Pi, install/reload this extension, then use /speak, /mono, /pk-remote, and /sess as usual.");
}

function printDoctor() {
	const config = loadPiSpeakSetupConfig();
	const configPath = getPiSpeakSetupConfigPath();
	console.log("Pi Speak doctor");
	console.log(`Config: ${existsSync(configPath) ? configPath : "not found"}`);
	console.log(`Package root: ${ROOT}`);
	console.log(`Agent: ${config.agentProvider || process.env.AGENT_PROVIDER || "codex"}`);
	console.log(`TTS: ${config.ttsProvider || process.env.PI_SPEAK_TTS_PROVIDER || "edge"}`);
	console.log(`Playback gate: ${describeSpeakPlaybackGate(normalizeSpeakPlaybackGate(config.speakPlaybackGate || process.env.PI_SPEAK_PLAYBACK_GATE) || "immediate")}`);
	console.log(`Gateway port: ${config.httpPort || process.env.PI_SPEAK_HTTP_PORT || "8767"}`);
	console.log(`Android APK: ${existsSync(join(ROOT, "android-app", ".build-outputs", "app-debug.apk")) ? "bundled" : "not bundled"}`);
}

function printHelp() {
	console.log([
		"Usage: pi-speak-pk [setup|doctor] [options]",
		"",
		"Runs the first-time Pi Speak setup wizard. The default command is setup.",
		"",
		"Options:",
		"  -y, --yes                 Use recommended defaults without prompts",
		"  --non-interactive         Do not prompt; use args/defaults",
		"  --provider <codex|claude|pi>",
		"  --router <auto|codex|claude|pi>",
		"  --tts <edge|elevenlabs|openai|sag|auto>",
		"  --speak-gate <immediate|enter>  Require Enter before spoken playback",
		"  --mobile <true|false>     Include Android setup in next steps",
		"  --tray <true|false>       Prefer the Windows tray launcher",
		"  --port <port>",
		"  --token <token>",
		"  --dry-run                 Print config without saving",
		"  --print-config-path       Print the setup config path",
		"",
		"After setup, run: pk-speak doctor, pk-speak tray, pk-speak mobile.",
	].join("\n"));
}

async function choice(rl: ReturnType<typeof createInterface> | undefined, options: {
	label: string;
	current?: string;
	defaultValue: string;
	choices: string[];
	yes: boolean;
	nonInteractive: boolean;
}) {
	const fallback = options.current || options.defaultValue;
	if (!rl || options.yes || options.nonInteractive) return normalizeChoice(fallback, options.choices, options.defaultValue);
	const answer = await rl.question(`${options.label} (${options.choices.join("/")}) [${fallback}]: `);
	return normalizeChoice(answer || fallback, options.choices, options.defaultValue);
}

async function text(rl: ReturnType<typeof createInterface> | undefined, options: {
	label: string;
	current?: string;
	defaultValue?: string;
	yes: boolean;
	nonInteractive: boolean;
}) {
	const fallback = options.current || options.defaultValue || "";
	if (!rl || options.yes || options.nonInteractive) return fallback;
	return (await rl.question(`${options.label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
}

async function secret(rl: ReturnType<typeof createInterface> | undefined, options: {
	label: string;
	current?: string;
	argValue?: string;
	defaultValue?: string;
	yes: boolean;
	nonInteractive: boolean;
}) {
	if (options.argValue) return options.argValue;
	const fallback = options.current || options.defaultValue || "";
	if (!rl || options.yes || options.nonInteractive) return fallback;
	const masked = fallback ? ` [${maskSecret(fallback)}]` : "";
	return (await rl.question(`${options.label}${masked}: `)).trim() || fallback;
}

async function bool(rl: ReturnType<typeof createInterface> | undefined, options: {
	label: string;
	current?: boolean;
	defaultValue: boolean;
	yes: boolean;
	nonInteractive: boolean;
}) {
	const fallback = options.current ?? options.defaultValue;
	if (!rl || options.yes || options.nonInteractive) return fallback;
	const answer = (await rl.question(`${options.label} (y/n) [${fallback ? "y" : "n"}]: `)).trim().toLowerCase();
	if (!answer) return fallback;
	return ["y", "yes", "true", "1", "on"].includes(answer);
}

function normalizeChoice(value: string, choices: string[], fallback: string) {
	const normalized = value.trim().toLowerCase();
	return choices.includes(normalized) ? normalized : fallback;
}

function parseArgs(argv: string[]): Args {
	const parsed: Args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith("-") && !parsed._) {
			parsed._ = arg;
			continue;
		}
		if (!arg.startsWith("-")) continue;
		const key = arg.replace(/^-+/, "");
		const value = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
		parsed[key] = value;
	}
	return parsed;
}

function valueArg(value: unknown) {
	return typeof value === "string" ? value.trim() : undefined;
}

function boolArg(value: unknown) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
	return undefined;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
