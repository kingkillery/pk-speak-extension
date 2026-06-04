#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiSpeakEnv, getPiSpeakSetupConfigPath, loadPiSpeakSetupConfig, maskSecret } from "./setup-config.js";

type Args = Record<string, string | boolean>;

const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIST_DIR, "..");

async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const command = String(args._ || "help").toLowerCase();
	if (args.help || args.h || command === "help") {
		printHelp();
		return;
	}
	if (command === "setup" || command === "init") {
		await runNodeScript(join(DIST_DIR, "pi-speak-pk.js"), argv.slice(1));
		return;
	}
	if (command === "doctor") {
		printDoctor();
		return;
	}
	if (command === "gateway" || command === "serve") {
		await runNodeScript(join(DIST_DIR, "headless-gateway.js"), argv.slice(1));
		return;
	}
	if (command === "tray") {
		await runNodeScript(join(DIST_DIR, "persistent-tray.js"), argv.slice(1));
		return;
	}
	if (command === "mobile" || command === "qr" || command === "android") {
		await runNodeScript(join(ROOT, "scripts", "qr-setup.mjs"), argv.slice(1));
		return;
	}
	if (command === "admin" || command === "sessions") {
		await runNodeScript(join(DIST_DIR, "ui", "admin.js"), argv.slice(1));
		return;
	}
	if (command === "config") {
		printConfig();
		return;
	}
	console.error(`Unknown pk-speak command: ${command}`);
	printHelp();
	process.exitCode = 1;
}

function printHelp() {
	console.log([
		"Usage: pk-speak <command> [options]",
		"",
		"Commands:",
		"  setup       Run first-time setup",
		"  doctor      Show configured backend, voice, APK, and gateway status inputs",
		"  gateway     Start the headless phone/control gateway",
		"  tray        Start the Windows tray controller and gateway",
		"  mobile      Print the Android setup/download QR",
		"  admin       Open the sessions admin pane",
		"  config      Show the saved setup profile path and masked values",
		"",
		"Typical flow:",
		"  pi-speak-pk",
		"  pk-speak tray",
		"  pk-speak mobile",
	].join("\n"));
}

function printDoctor() {
	const config = loadPiSpeakSetupConfig();
	const configPath = getPiSpeakSetupConfigPath();
	console.log("pk-speak doctor");
	console.log(`Config: ${existsSync(configPath) ? configPath : "not found; run pi-speak-pk"}`);
	console.log(`Package root: ${ROOT}`);
	console.log(`Agent provider: ${config.agentProvider || process.env.AGENT_PROVIDER || "codex"}`);
	console.log(`Voice router: ${config.executionRouterMode || process.env.PI_SPEAK_EXECUTION_ROUTER_MODE || "auto"}`);
	console.log(`TTS provider: ${config.ttsProvider || process.env.PI_SPEAK_TTS_PROVIDER || "edge"}`);
	console.log(`Gateway port: ${config.httpPort || process.env.PI_SPEAK_HTTP_PORT || "8767"}`);
	console.log(`Gateway token: ${maskSecret(config.httpToken || process.env.PI_SPEAK_HTTP_TOKEN) || "not configured"}`);
	console.log(`Android APK: ${existsSync(join(ROOT, "android-app", ".build-outputs", "app-debug.apk")) ? "bundled" : "not bundled"}`);
	console.log(`Headless gateway: ${existsSync(join(DIST_DIR, "headless-gateway.js")) ? "built" : "missing"}`);
	console.log(`Tray controller: ${existsSync(join(DIST_DIR, "persistent-tray.js")) ? "built" : "missing"}`);
}

function printConfig() {
	const config = loadPiSpeakSetupConfig();
	const configPath = getPiSpeakSetupConfigPath();
	console.log(`Config: ${configPath}`);
	console.log(`Agent provider: ${config.agentProvider || ""}`);
	console.log(`Voice router: ${config.executionRouterMode || ""}`);
	console.log(`TTS provider: ${config.ttsProvider || ""}`);
	console.log(`ElevenLabs key: ${maskSecret(config.elevenLabsApiKey)}`);
	console.log(`OpenAI audio key: ${maskSecret(config.openAiKey)}`);
	console.log(`Gateway token: ${maskSecret(config.httpToken)}`);
}

async function runNodeScript(scriptPath: string, args: string[]) {
	if (!existsSync(scriptPath)) {
		throw new Error(`Command target not found: ${scriptPath}`);
	}
	const child = spawn(process.execPath, [scriptPath, ...args], {
		cwd: process.cwd(),
		env: buildPiSpeakEnv(),
		stdio: "inherit",
		windowsHide: false,
	});
	await new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			process.exitCode = code ?? 0;
			resolve();
		});
	});
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

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
