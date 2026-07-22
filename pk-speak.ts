#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPiSpeakSetupConfig, buildPiSpeakEnv, getPiSpeakSetupConfigPath, loadPiSpeakSetupConfig, maskSecret, savePiSpeakSetupConfig } from "./setup-config.js";
import { getAudioMimeType, resolveTtsProvider, sanitizeForSpeech, synthesizeToFile, type TtsProvider } from "./tts.js";
import { transcribeAudioBuffer } from "./stt.js";
import { runGeminiTextTurn } from "./gemini-live-turn.js";
import {
	describeSpeakPlaybackGate,
	normalizeSpeakPlaybackGate,
	resolveSpeakPlaybackGate,
	waitForSpeakPlaybackGate,
	type SpeakPlaybackGate,
} from "./speak-gate.js";
import { getRealtimeTerminalAuditPath } from "./realtime-terminal-audit.js";
import { clearRootVoiceDisable, enableRootVoiceDisable, isRootVoiceDisabled } from "./pairing.js";
import { playAudioFile } from "./audio-playback.js";
import { buildDesktopLiveClientUrl, buildDesktopSpeechClientUrl, openDesktopLiveClient, openDesktopSpeechClient } from "./desktop-live-client.js";

type Args = Record<string, string | boolean>;

const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIST_DIR, "..");

applyPiSpeakSetupConfig();

async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);

	if (args.version || args.V) {
		console.log(getPackageVersion());
		return;
	}

	if ((args.help || args.h) && !args._) {
		printHelp();
		return;
	}

	if (!args._) {
		console.error("Unknown pk-speak command");
		printHelp();
		process.exitCode = 1;
		return;
	}

	const command = String(args._).toLowerCase();
	const commandArgv = argv.slice(1);
	const dryRun = hasFlag(commandArgv, "dry-run") || args["dry-run"] === true;
	const wantsHelp = hasFlag(commandArgv, "help") || hasFlag(commandArgv, "h");

	if (command === "help") {
		printHelp();
		return;
	}
	if (command === "setup" || command === "init") {
		if (wantsHelp) {
			printSetupHelp();
			return;
		}
		await runNodeScript(join(DIST_DIR, "pi-speak-pk.js"), stripMetaFlags(commandArgv));
		return;
	}
	if (command === "doctor") {
		if (wantsHelp) {
			printDoctorHelp();
			return;
		}
		if (dryRun) {
			printDoctorDryRun();
			return;
		}
		printDoctor();
		return;
	}
	if (command === "speak" || command === "say") {
		await runSpeakCommand(commandArgv);
		return;
	}
	if (command === "enable" || command === "on") {
		if (wantsHelp) { printEnableHelp(); return; }
		runEnableSpeechCommand();
		return;
	}
	if (command === "disable" || command === "stop") {
		if (wantsHelp) { printDisableHelp(); return; }
		runDisableSpeechCommand();
		return;
	}
	if (command === "wrap") {
		await runWrapCommand(commandArgv);
		return;
	}
	if (command === "brainstorm" || command === "bs") {
		await runBrainstormCommand(commandArgv);
		return;
	}
	if (command === "gateway" || command === "serve") {
		if (wantsHelp) {
			printGatewayHelp();
			return;
		}
		const gatewayArgs = stripMetaFlags(commandArgv);
		const liveMode = gatewayArgs.includes("--live");
		const passthrough = gatewayArgs.filter((arg) => arg !== "--live");
		const scriptPath = join(DIST_DIR, "headless-gateway.js");
		const envExtras = liveMode ? { AGENT_PROVIDER: "gemini-live" } : undefined;
		if (dryRun) {
			printNodeScriptDryRun("gateway", scriptPath, passthrough, envExtras);
			return;
		}
		await runNodeScript(scriptPath, passthrough, envExtras);
		return;
	}
	if (command === "live" || command === "desktop") {
		if (wantsHelp) {
			printLiveHelp();
			return;
		}
		const passthrough = stripMetaFlags(commandArgv).filter((arg) => arg !== "--no-window");
		const runtimeEnv = buildPiSpeakEnv();
		const portValue = typeof args.port === "string" ? args.port : runtimeEnv.PI_SPEAK_HTTP_PORT || "";
		const port = Number.parseInt(portValue, 10) || 8767;
		const cwd = typeof args.cwd === "string" ? resolve(args.cwd) : process.cwd();
		const serverScript = join(DIST_DIR, "server-app.js");
		const gatewayEntry = join(DIST_DIR, "headless-gateway.js");
		const serverArgs = ["--no-window", "--gateway", gatewayEntry, ...passthrough];
		if (dryRun) {
			printNodeScriptDryRun("live gateway", serverScript, serverArgs, { AGENT_PROVIDER: "gemini-live" });
			console.log(`Would open desktop live client: ${buildDesktopLiveClientUrl(port, cwd)}`);
			return;
		}
		await runNodeScript(serverScript, serverArgs, { AGENT_PROVIDER: "gemini-live" });
		if (process.exitCode && process.exitCode !== 0) return;
		await assertDesktopLiveWorkspace(port, cwd);
		const launched = openDesktopLiveClient({ port, cwd });
		console.log(launched.mode === "edge-app"
			? "Opened the Gemini Live desktop client in Edge app mode. Tap Start live once to grant microphone access."
			: "Opened the Gemini Live desktop client in your browser. Tap Start live once to grant microphone access.");
		return;
	}
	if (command === "tray") {
		if (wantsHelp) {
			printTrayHelp();
			return;
		}
		const scriptPath = join(DIST_DIR, "persistent-tray.js");
		const passthrough = stripMetaFlags(commandArgv);
		if (dryRun) {
			printNodeScriptDryRun("tray", scriptPath, passthrough);
			return;
		}
		await runNodeScript(scriptPath, passthrough);
		return;
	}
	if (command === "mobile" || command === "qr" || command === "android") {
		if (wantsHelp) {
			printMobileHelp();
			return;
		}
		const scriptPath = join(ROOT, "scripts", "qr-setup.mjs");
		const passthrough = stripMetaFlags(commandArgv);
		if (dryRun) {
			printNodeScriptDryRun("mobile", scriptPath, passthrough);
			return;
		}
		await runNodeScript(scriptPath, passthrough);
		return;
	}
	if (command === "admin" || command === "sessions") {
		if (wantsHelp) {
			printAdminHelp();
			return;
		}
		const scriptPath = join(DIST_DIR, "ui", "admin.js");
		const passthrough = stripMetaFlags(commandArgv);
		if (dryRun) {
			printNodeScriptDryRun("admin", scriptPath, passthrough);
			return;
		}
		await runNodeScript(scriptPath, passthrough);
		return;
	}
	if (command === "config") {
		if (wantsHelp) {
			printConfigHelp();
			return;
		}
		if (dryRun) {
			printConfigDryRun();
			return;
		}
		printConfig();
		return;
	}
	if (command === "phone" || command === "telegram") {
		if (wantsHelp) {
			printPhoneHelp();
			return;
		}
		if (dryRun) {
			printPhoneDryRun();
			return;
		}
		await runPhoneCommand(stripMetaFlags(commandArgv));
		return;
	}
	console.error(`Unknown pk-speak command: ${command}`);
	printHelp();
	process.exitCode = 1;
}

function printHelp() {
	console.log([
		"Usage: pk-speak <command> [options]",
		"       pk-speak --version",
		"",
		"Commands:",
		"  setup       Run first-time setup (no --dry-run)",
		"  doctor      Show configured backend, voice, APK, and gateway status inputs (--dry-run)",
		"  speak       Speak text from args or stdin using configured TTS (--dry-run)",
		"  enable      Re-enable speech after it was disabled from the orb or `pk-speak disable`",
		"  disable     Disable speech (writes the hard-stop sentinel; orb's Stop-Disable uses the same primitive)",
		"  wrap        Run a CLI command and speak start/finish notices (--dry-run)",
		"  brainstorm  Transcribe brainstorm audio using WhisperX and structure it (--dry-run)",
		"  gateway     Start the headless phone/control gateway (add --live for Gemini Live barge-in) (--dry-run)",
		"  tray        Start the Windows tray controller and gateway (--dry-run)",
		"  mobile      Print the Android setup/download QR (--dry-run)",
		"  admin       Open the sessions admin pane (--dry-run)",
		"  config      Show the saved setup profile path and masked values (--dry-run)",
		"  phone       Configure or control Telegram pairing for the gateway (--dry-run)",
		"  help        Show this help",
		"",
		"--dry-run support:",
		"  Supported: doctor, speak, wrap, brainstorm, gateway, live, tray, mobile, admin, config",
		"  Not supported: setup",
		"  Dry-run prints the resolved plan and exits 0 without spawning subprocesses, opening ports, writing files, or playing audio.",
		"",
		"Typical flow:",
		"  pi-speak-pk",
		"  pk-speak tray",
		"  pk-speak live",
		"  pk-speak mobile",
		"",
		"Speak examples:",
		"  pk-speak speak \"Build finished\"",
		"  git status --short | pk-speak speak --provider edge",
		"  pk-speak speak --no-play --output reply.mp3 \"Tests passed\"",
		"",
		"Wrap examples:",
		"  pk-speak wrap -- codex",
		"  pk-speak wrap --label \"Claude Code\" -- claude",
		"  pk-speak wrap --provider sag -- npm test",
	].join("\n"));
}
function printEnableHelp() {
	console.log([
		"Usage: pk-speak enable",
		"       pk-speak on",
		"",
		"Clears the hard-stop sentinel written by the orb's \"Disable speech\"",
		"button or `pk-speak disable`. Idempotent: a no-op if speech is already enabled.",
		"",
		"Once speech is disabled, `pk-speak speak` exits before opening the orb,",
		"so this command is the supported re-enable path from the terminal.",
	].join("\n"));
}

function printDisableHelp() {
	console.log([
		"Usage: pk-speak disable",
		"       pk-speak stop",
		"",
		"Writes the hard-stop sentinel so subsequent `pk-speak speak` invocations",
		"and assistant replies no-op before synthesis. Idempotent.",
		"",
		"Re-enable with: pk-speak enable",
	].join("\n"));
}

function printSetupHelp() {
	console.log([
		"Usage: pk-speak setup [options]",
		"",
		"Runs first-time setup via pi-speak-pk.",
		"",
		"Options:",
		"  -h, --help    Show this help",
		"",
		"--dry-run is not supported for setup.",
		"",
		"Examples:",
		"  pk-speak setup",
		"  pk-speak init",
	].join("\n"));
}

function printDoctorHelp() {
	console.log([
		"Usage: pk-speak doctor [--dry-run]",
		"",
		"Shows configured backend, voice, APK, and gateway status inputs.",
		"",
		"Options:",
		"  --dry-run     Print the doctor plan without reading user env via powershell or mutating state",
		"  -h, --help    Show this help",
		"",
		"Examples:",
		"  pk-speak doctor --help",
		"  pk-speak doctor --dry-run",
		"  pk-speak doctor",
	].join("\n"));
}

function printPhoneHelp() {
	console.log([
		"Usage: pk-speak phone [status|on|off|code|unpair]",
		"       pk-speak phone token <bot-token>",
		"",
		"Stores the Telegram bot token in the local Pi Speak setup profile, then controls",
		"the daemon-hosted Telegram transport for ompk and Agent Hub sessions.",
		"",
		"Examples:",
		"  pk-speak phone token 123456:ABC...",
		"  pk-speak phone code",
		"  pk-speak phone status",
	].join("\n"));
}

function printPhoneDryRun() {
	console.log("dry-run: pk-speak phone");
	console.log("Would save a supplied Telegram bot token to the local setup profile, or call the local gateway phone action.");
	console.log("Would not send Telegram requests, start the bridge, or expose the token.");
}

async function runPhoneCommand(commandArgv: string[]) {
	const [rawAction = "status", ...rest] = commandArgv;
	const action = rawAction.toLowerCase();
	if (action === "token") {
		const token = rest.join(" ").trim();
		if (!token) throw new Error("Usage: pk-speak phone token <bot-token>");
		const config = loadPiSpeakSetupConfig();
		savePiSpeakSetupConfig({ ...config, telegramBotToken: token });
		console.log("Telegram bot token saved. Starting the pairing bridge on the local gateway...");
		const result = await callGatewayPhoneAction("on");
		console.log(result.message);
		return;
	}
	if (!["status", "on", "off", "code", "unpair"].includes(action)) {
		throw new Error("Usage: pk-speak phone [status|on|off|code|unpair] or pk-speak phone token <bot-token>");
	}
	const result = await callGatewayPhoneAction(action as "on" | "off" | "status" | "code" | "unpair");
	console.log(result.message);
}

async function callGatewayPhoneAction(action: "on" | "off" | "status" | "code" | "unpair") {
	const config = loadPiSpeakSetupConfig();
	const configuredPort = config.httpPort || process.env.PI_SPEAK_HTTP_PORT || "8767";
	const host = process.env.PI_SPEAK_HTTP_HOST || "127.0.0.1";
	const token = config.httpToken || process.env.PI_SPEAK_HTTP_TOKEN || "";
	// Older tray installs used 8768 while current setup defaults to 8767. Probe
	// only a Pi Speak gateway health route before sending an authenticated action.
	const ports = [...new Set([configuredPort, "8767", "8768"])];
	const failures: string[] = [];
	for (const port of ports) {
		try {
			const health = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1_500) });
			const healthPayload = await health.json() as { ok?: boolean; app?: string; role?: string };
			if (!health.ok || healthPayload.app !== "pi-speak" || healthPayload.role !== "gateway") continue;
			const response = await fetch(`http://${host}:${port}/v1/phone/${action}`, {
				method: action === "status" ? "GET" : "POST",
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
				signal: AbortSignal.timeout(10_000),
			});
			const payload = await response.json() as { ok?: boolean; message?: string };
			if (!response.ok || !payload.ok) throw new Error(payload.message || `Gateway returned ${response.status}.`);
			return { message: payload.message || "Phone action completed." };
		} catch (error) {
			failures.push(`${port}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Could not reach a Pi Speak gateway at ${host} (tried ${ports.join(", ")}). ${failures.at(-1) || ""}`.trim());
}

function printConfigHelp() {
	console.log([
		"Usage: pk-speak config [--dry-run]",
		"",
		"Shows the saved setup profile path and masked values.",
		"",
		"Options:",
		"  --dry-run     Print the config plan without writing files",
		"  -h, --help    Show this help",
		"",
		"Examples:",
		"  pk-speak config --help",
		"  pk-speak config --dry-run",
		"  pk-speak config",
	].join("\n"));
}

function printGatewayHelp() {
	console.log([
		"Usage: pk-speak gateway [--live] [--dry-run] [args...]",
		"",
		"Starts the headless phone/control gateway.",
		"",
		"Options:",
		"  --live        Set AGENT_PROVIDER=gemini-live for barge-in",
		"  --dry-run     Print the planned node command without spawning it",
		"  -h, --help    Show this help",
		"",
		"Examples:",
		"  pk-speak gateway --help",
		"  pk-speak gateway --dry-run",
		"  pk-speak gateway",
		"  pk-speak gateway --live",
	].join("\n"));
}

function printLiveHelp() {
	console.log([
		"Usage: pk-speak live [--port <port>] [--cwd <path>] [--dry-run]",
		"",
		"Starts or reuses the local gateway and opens Gemini Live in a desktop app window.",
		"The loopback client streams 16 kHz microphone PCM to /v1/live and plays 24 kHz replies.",
		"",
		"Options:",
		"  --port <port>  Gateway port. Defaults to PI_SPEAK_HTTP_PORT or 8767",
		"  --cwd <path>   Working directory exposed to the live assistant",
		"  --dry-run      Print the gateway and desktop launch plan",
		"  -h, --help     Show this help",
		"",
		"Example:",
		"  pk-speak live",
	].join("\n"));
}

function printTrayHelp() {
	console.log([
		"Usage: pk-speak tray [--dry-run] [args...]",
		"",
		"Starts the Windows tray controller and gateway.",
		"",
		"Options:",
		"  --dry-run     Print the planned node command without spawning it",
		"  -h, --help    Show this help",
		"",
		"Examples:",
		"  pk-speak tray --help",
		"  pk-speak tray --dry-run",
		"  pk-speak tray",
	].join("\n"));
}

function printMobileHelp() {
	console.log([
		"Usage: pk-speak mobile [--dry-run] [args...]",
		"",
		"Prints the Android setup/download QR via scripts/qr-setup.mjs.",
		"",
		"Options:",
		"  --dry-run     Print the planned node command without spawning it",
		"  -h, --help    Show this help",
		"",
		"Examples:",
		"  pk-speak mobile --help",
		"  pk-speak mobile --dry-run",
		"  pk-speak mobile",
	].join("\n"));
}

function printAdminHelp() {
	console.log([
		"Usage: pk-speak admin [--dry-run] [args...]",
		"",
		"Opens the sessions admin pane.",
		"",
		"Options:",
		"  --dry-run     Print the planned node command without spawning it",
		"  -h, --help    Show this help",
		"",
		"Examples:",
		"  pk-speak admin --help",
		"  pk-speak admin --dry-run",
		"  pk-speak admin",
	].join("\n"));
}

function printDoctorDryRun() {
	const configPath = getPiSpeakSetupConfigPath();
	console.log("dry-run: pk-speak doctor");
	console.log(`Would load setup config from: ${configPath}`);
	console.log(`Package root: ${ROOT}`);
	console.log("Would report: agent provider, voice router, TTS provider, playback gate, ElevenLabs key source, gateway port/token, realtime terminal audit path, Android APK, headless gateway, tray controller");
	console.log("Would not spawn powershell.exe, open network ports, write files, or play audio");
}

function printConfigDryRun() {
	const configPath = getPiSpeakSetupConfigPath();
	console.log("dry-run: pk-speak config");
	console.log(`Would read setup config from: ${configPath}`);
	console.log("Would print masked profile values (agent provider, voice router, TTS provider, playback gate, API keys, gateway token)");
	console.log("Would not write files, spawn subprocesses, open network ports, or play audio");
}

function printNodeScriptDryRun(
	commandName: string,
	scriptPath: string,
	args: string[],
	envExtras?: NodeJS.ProcessEnv,
) {
	console.log(`dry-run: pk-speak ${commandName}`);
	if (!existsSync(scriptPath)) {
		if (isDistBuildTarget(scriptPath)) {
			console.log(`${scriptPath}: not built — run npm run build`);
		} else {
			console.log(`Command target not found: ${scriptPath}`);
		}
	} else {
		console.log(`Would run: ${process.execPath} ${[scriptPath, ...args].join(" ")}`);
	}
	if (envExtras && Object.keys(envExtras).length > 0) {
		const rendered = Object.entries(envExtras)
			.map(([key, value]) => `${key}=${value ?? ""}`)
			.sort()
			.join(" ");
		console.log(`Env: ${rendered}`);
	}
	console.log("Would not spawn a child process, open network ports, write files, or play audio");
}

function getPackageVersion(): string {
	const pkgPath = join(ROOT, "package.json");
	const raw = readFileSync(pkgPath, "utf8");
	const pkg = JSON.parse(raw) as { version?: string };
	return pkg.version ?? "0.0.0";
}

function hasFlag(argv: string[], name: string): boolean {
	const long = `--${name}`;
	const short = `-${name}`;
	return argv.some((arg) => arg === long || arg === short);
}

function stripMetaFlags(argv: string[]): string[] {
	return argv.filter((arg) => arg !== "--dry-run" && arg !== "--help" && arg !== "-h");
}

function isDistBuildTarget(scriptPath: string): boolean {
	const normalized = scriptPath.replace(/\\/g, "/");
	const distNormalized = DIST_DIR.replace(/\\/g, "/");
	return normalized === distNormalized || normalized.startsWith(`${distNormalized}/`);
}

function printDoctor() {
	const config = loadPiSpeakSetupConfig();
	const configPath = getPiSpeakSetupConfigPath();
	const elevenLabsEnv = describeSecretSource("ELEVENLABS_API_KEY", config.elevenLabsApiKey);
	console.log("pk-speak doctor");
	console.log(`Config: ${existsSync(configPath) ? configPath : "not found; run pi-speak-pk"}`);
	console.log(`Package root: ${ROOT}`);
	console.log(`Agent provider: ${config.agentProvider || process.env.AGENT_PROVIDER || "codex"}`);
	console.log(`Voice router: ${config.executionRouterMode || process.env.PI_SPEAK_EXECUTION_ROUTER_MODE || "auto"}`);
	console.log(`TTS provider: ${config.ttsProvider || process.env.PI_SPEAK_TTS_PROVIDER || "auto"}`);
	console.log(`Playback gate: ${describeSpeakPlaybackGate(resolveSpeakPlaybackGate({ env: process.env, config }))}`);
	console.log(`ElevenLabs key: ${elevenLabsEnv.summary}`);
	if (elevenLabsEnv.warning) console.log(`Warning: ${elevenLabsEnv.warning}`);
	console.log(`Gateway port: ${config.httpPort || process.env.PI_SPEAK_HTTP_PORT || "8767"}`);
	console.log(`Gateway token: ${maskSecret(config.httpToken || process.env.PI_SPEAK_HTTP_TOKEN) || "not configured"}`);
	const realtimeAuditPath = getRealtimeTerminalAuditPath();
	console.log(`Realtime terminal audit: ${existsSync(realtimeAuditPath) ? realtimeAuditPath : `${realtimeAuditPath} (no entries yet)`}`);
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
	console.log(`Playback gate: ${describeSpeakPlaybackGate(resolveSpeakPlaybackGate({ env: process.env, config }))}`);
	console.log(`ElevenLabs key: ${maskSecret(config.elevenLabsApiKey)}`);
	console.log(`OpenAI audio key: ${maskSecret(config.openAiKey)}`);
	console.log(`Gateway token: ${maskSecret(config.httpToken)}`);
	console.log(`Telegram bot token: ${maskSecret(config.telegramBotToken)}`);
}

function describeSecretSource(envName: string, configValue?: string) {
	const processValue = process.env[envName]?.trim() || "";
	const userValue = readUserEnvValue(envName);
	const hasConfig = !!configValue?.trim();
	const sources = [
		processValue ? "process env" : "",
		userValue ? "user env" : "",
		hasConfig ? "setup config" : "",
	].filter(Boolean);
	const summary = sources.length ? `configured (${sources.join(", ")})` : "not configured";
	const warning = processValue && userValue && processValue !== userValue
		? `${envName} differs between this shell and the persisted user environment; new terminals may use a different key.`
		: undefined;
	return { summary, warning };
}

function readUserEnvValue(name: string) {
	const testOverride = process.env[`PI_SPEAK_TEST_USER_ENV_${name}`];
	if (testOverride !== undefined) return testOverride.trim();
	if (process.platform !== "win32") return "";
	const result = spawnSync("powershell.exe", [
		"-NoProfile",
		"-Command",
		`[string][Environment]::GetEnvironmentVariable('${name.replace(/'/g, "''")}','User')`,
	], {
		encoding: "utf8",
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 3000,
	});
	if (result.status !== 0 || result.error) return "";
	return (result.stdout || "").trim();
}

function applyUserEnvSecretWhenDifferent(name: string) {
	const userValue = readUserEnvValue(name);
	if (!userValue) return false;
	if (process.env[name]?.trim() === userValue) return false;
	process.env[name] = userValue;
	return true;
}

async function runSpeakCommand(argv: string[]) {
	const options = parseSpeakArgs(argv);
	if (options.help) {
		printSpeakHelp();
		return;
	}

	let text = "";
	if (options.input) {
		const filePath = resolve(options.input);
		if (!existsSync(filePath)) {
			console.error(`Audio input file not found: ${filePath}`);
			process.exitCode = 1;
			return;
		}
		const fileBuffer = await readFile(filePath);
		const mimeType = getAudioMimeType(filePath);
		const result = await transcribeAudioBuffer(fileBuffer, mimeType);
		text = result.text;
		if (!options.quiet && options.dryRun) {
			console.log(`Transcribed with ${result.provider}: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
		}
	} else {
		text = (options.textParts.join(" ") || await readStdin()).trim();
	}

	if (!text) {
		console.error("No text provided. Pass text as arguments, pipe it on stdin, or use --input with an audio file.");
		printSpeakHelp();
		process.exitCode = 1;
		return;
	}

	let finalText = text;
	if (options.summarize) {
		finalText = await summarizeText(text);
		if (!options.quiet && options.dryRun) {
			console.log(`Summary: ${finalText.slice(0, 200)}${finalText.length > 200 ? "..." : ""}`);
		}
	}

	const abortController = new AbortController();
	const abort = () => abortController.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		await speakText(finalText, { ...options, signal: abortController.signal });
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}

async function summarizeText(text: string): Promise<string> {
	const prompt = `Summarize the following text into one or two sentences suitable for spoken playback. Keep it concise and natural.\n\n${text}`;
	const result = await runGeminiTextTurn(prompt);
	if (!result.replyText || result.replyText === "Gemini completed the turn without returning text.") {
		throw new Error("Summarization failed: Gemini returned no text.");
	}
	return result.replyText.trim();
}

async function speakText(text: string, options: SpeakTextOptions) {
	options.signal?.throwIfAborted();
	if (options.provider === "elevenlabs" || options.provider === "sag") {
		applyUserEnvSecretWhenDifferent("ELEVENLABS_API_KEY");
	}
	const state = {
		provider: options.provider,
		rewriteEnabled: options.rewrite,
	};
	const resolvedProvider = resolveTtsProvider(state);
	const spokenPreview = sanitizeForSpeech(text);
	if (options.dryRun) {
		if (options.provider) console.log(`Requested provider: ${options.provider}`);
		console.log(`Provider: ${resolvedProvider}`);
		console.log(`Text: ${spokenPreview}`);
		console.log(`Playback gate: ${describeSpeakPlaybackGate(resolveSpeakPlaybackGate({ cliGate: options.gate, env: process.env, config: loadPiSpeakSetupConfig() }))}`);
		if (isRootVoiceDisabled()) console.log("Speech disabled: yes (a real run would exit before synthesis; re-enable with `pk-speak enable`)");
		return;
	}
	// The orb's "Disable speech" button (and `pk-speak disable`) write the
	// hard-stop sentinel. Honor it BEFORE synthesis so we don't burn a TTS
	// call, stage an artifact, or pop the orb open while claiming silence.
	// Deliberately AFTER the dry-run return: dry-run never synthesizes or
	// plays, and keeping it working preserves diagnostics while disabled.
	if (isRootVoiceDisabled()) {
		console.error("pk-speak: speech is disabled. Re-enable with: pk-speak enable");
		return;
	}
	const tempDir = options.output ? undefined : await mkdtemp(join(tmpdir(), "pk-speak-"));
	let removeTempDir = !!tempDir && !options.keep;
	const outputPath = resolve(options.output || join(tempDir!, "speech.mp3"));
	try {
		const result = await synthesizeToFile({
			text,
			outputPath,
			state,
			signal: options.signal,
		});
		if (!options.quiet) {
			console.log(`Spoke with ${result.provider}${result.rewriteApplied ? " (rewritten)" : ""}: ${outputPath}`);
		}
		if (!options.noPlay) {
			const gate = resolveSpeakPlaybackGate({ cliGate: options.gate, env: process.env, config: loadPiSpeakSetupConfig() });
			const gateResult = await waitForSpeakPlaybackGate(gate, { signal: options.signal });
			if (gateResult === "skipped") {
				console.warn(`pk-speak playback gated (${describeSpeakPlaybackGate(gate)}) but stdin is not interactive; audio left at ${outputPath}.`);
				removeTempDir = false;
				return;
			}
			if (gate === "orb") {
				// Interactive orb path: stage at the gateway and open the orb.
				// Audio NEVER auto-plays from the terminal; the orb's <audio>
				// element + Stop/Disable buttons are the operator's controls.
				// On any failure we leave the file on disk with a clear error
				// rather than fall back to local auto-play.
			const orbResult = await stageAndOpenSpeechOrb({ text, outputPath, signal: options.signal });
			if (!orbResult.ok) {
				// Staging/open failed: leave the synthesized file on disk so the
				// operator can replay/upload manually. removeTempDir stays false.
				console.error(`pk-speak: audio left at ${outputPath}. ${orbResult.error}`);
				removeTempDir = false;
			} else if (!options.quiet) {
				console.log(`Speech orb opened. Audio staged at gateway; controls are in the orb window.`);
				// Success: the gateway owns its own staged copy now. Let the
				// temp dir cleanup run normally (no-op when --output was passed,
				// since tempDir is undefined in that case).
			}
			return;
		}
			const playback = await playAudioFile(outputPath, {
				allowOpenFallback: options.allowOpenFallback,
				wait: options.wait,
				cleanupDir: tempDir,
				signal: options.signal,
			});
			if (playback === "opened" || playback === "started") removeTempDir = false;
		}
	} finally {
		if (tempDir && removeTempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/**
 * `pk-speak enable` / `pk-speak on` — clears the hard-stop sentinel written by
 * the orb's "Disable speech" button (or `pk-speak disable`). This is the
 * supported re-enable path: once speech is disabled, `pk-speak speak` exits
 * before opening the orb, so the orb's own "Re-enable speech" button is not
 * reachable from the CLI surface.
 */
function runEnableSpeechCommand() {
	if (!isRootVoiceDisabled()) {
		console.log("Speech is already enabled.");
		return;
	}
	clearRootVoiceDisable();
	console.log("Speech re-enabled. Future `pk-speak speak` invocations will synthesize and open the orb again.");
}

/**
 * `pk-speak disable` / `pk-speak stop` — writes the hard-stop sentinel. The
 * orb's "Disable speech" button calls the same primitive via /v1/speech/disable.
 */
function runDisableSpeechCommand() {
	if (isRootVoiceDisabled()) {
		console.log("Speech is already disabled.");
		return;
	}
	enableRootVoiceDisable();
	console.log("Speech disabled. Re-enable with: pk-speak enable");
}

/**
 * Stage a synthesized TTS artifact at the gateway and open the speech-mode
 * orb. The audio file is uploaded as raw bytes (never referenced by path),
 * so an authenticated remote client can't turn this into a local-file read
 * primitive. Reply text travels base64url-encoded in a header so Node's
 * HTTP parser doesn't choke on Unicode.
 *
 * Never auto-plays. On any failure (gateway down, staging 4xx/5xx, orb
 * spawn failure), returns ok:false so the caller leaves the file on disk
 * with an actionable error. No silent autoplay fallback.
 */
async function stageAndOpenSpeechOrb({ text, outputPath, signal }: { text: string; outputPath: string; signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; error: string }> {
	const port = resolveSpeechGatewayPort();
	if (!port) return { ok: false, error: "PI_SPEAK_HTTP_PORT unset; cannot reach the gateway." };
	const authToken = process.env.PI_SPEAK_HTTP_TOKEN?.trim() || "";

	let audioBuffer: Buffer;
	try {
		audioBuffer = await readFile(outputPath);
	} catch (error) {
		return { ok: false, error: `Could not read synthesized audio: ${getErrorMessage(error)}` };
	}
	if (audioBuffer.byteLength === 0) return { ok: false, error: "Synthesized audio is empty." };

	const mimeType = inferAudioMimeType(outputPath);
	const encodedText = Buffer.from(text, "utf8").toString("base64url");
	const stageUrl = `http://127.0.0.1:${port}/v1/speech/stage`;
	const headers: Record<string, string> = {
		"Content-Type": mimeType,
		"X-Pi-Speak-Speech-Text-B64": encodedText,
	};
	if (authToken) headers["X-Pi-Speak-Token"] = authToken;

	const audioBody = new Blob([audioBuffer as unknown as BlobPart], { type: mimeType });
	let staged: { id?: string } | undefined;
	try {
		const res = await fetch(stageUrl, {
			method: "POST",
			headers,
			body: audioBody,
			signal,
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({})) as { error?: string };
			return { ok: false, error: `Gateway rejected staging (HTTP ${res.status}): ${err.error || res.statusText}` };
		}
		staged = await res.json() as { id?: string };
	} catch (error) {
		return { ok: false, error: `Could not reach gateway at ${stageUrl}: ${getErrorMessage(error)}` };
	}
	if (!staged?.id) return { ok: false, error: "Gateway did not return a speech artifact id." };

	const orbUrl = buildDesktopSpeechClientUrl(port, staged.id, { authToken });
	try {
		const launch = openDesktopSpeechClient({ port, cwd: process.cwd(), speechId: staged.id, authToken });
		// Command-not-found (missing xdg-open/Edge/explorer) arrives as an
		// ASYNC "error" event — a sync try/catch alone would report success
		// and let the caller delete the synthesized file. Await confirmation.
		const spawned = await launch.launched;
		if (!spawned.ok) {
			return { ok: false, error: `Gateway staged the audio but the orb did not open: ${spawned.error}. Browse to ${orbUrl} manually.` };
		}
	} catch (error) {
		return { ok: false, error: `Gateway staged the audio but the orb did not open: ${getErrorMessage(error)}. Browse to ${orbUrl} manually.` };
	}
	return { ok: true };
}

function resolveSpeechGatewayPort(): number | undefined {
	// Default to the standard gateway port (DEFAULT_PORT in control-server.ts
	// is 8767) so a default-config install without PI_SPEAK_HTTP_PORT set
	// still finds its gateway. Explicitly invalid values are rejected.
	const raw = process.env.PI_SPEAK_HTTP_PORT?.trim();
	const candidate = raw ? Number.parseInt(raw, 10) : 8767;
	if (!Number.isFinite(candidate) || candidate < 1 || candidate > 65_535) return undefined;
	return candidate;
}

function inferAudioMimeType(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".mp3")) return "audio/mpeg";
	if (lower.endsWith(".wav")) return "audio/wav";
	if (lower.endsWith(".ogg")) return "audio/ogg";
	if (lower.endsWith(".webm")) return "audio/webm";
	return "audio/mpeg";
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

async function runWrapCommand(argv: string[]) {
	const options = parseWrapArgs(argv);
	if (options.help) {
		printWrapHelp();
		return;
	}
	if (!options.command.length) {
		console.error("No command provided. Use: pk-speak wrap -- <command> [args...]");
		printWrapHelp();
		process.exitCode = 1;
		return;
	}

	const command = options.command[0];
	const args = options.command.slice(1);
	const label = options.label || commandLabel(command);
	const startMessage = options.startText || `Starting ${label}.`;
	const successMessage = options.successText || `${label} finished successfully.`;
	const failureMessage = options.failureText || `${label} exited with code`;

	if (options.dryRun) {
		console.log(`Command: ${options.command.join(" ")}`);
		console.log(`Cwd: ${resolve(options.cwd || process.cwd())}`);
		console.log(`Shell: ${options.shell ? "yes" : "no"}`);
		console.log(`Capture: ${options.capture ? "yes" : "no"}`);
		if (!options.noSpeak) {
			console.log(`Start notice: ${startMessage}`);
			console.log(`Success notice: ${successMessage}`);
			console.log(`Failure notice: ${failureMessage} <code>`);
			console.log(`Playback gate: ${describeSpeakPlaybackGate(resolveSpeakPlaybackGate({ cliGate: options.gate, env: process.env, config: loadPiSpeakSetupConfig() }))}`);
		}
		return;
	}

	if (!options.noSpeak && !options.noStart) {
		await speakTextSafely(startMessage, options);
	}
	const exit = await runWrappedProcess(command, args, options);
	if (exit.capture && exit.capture.events.length) {
		console.log(`pk-speak capture: ${exit.capture.events.join(", ")}`);
	}
	if (!options.noSpeak) {
		const message = buildWrapFinishMessage(exit, label, successMessage, failureMessage);
		await speakTextSafely(message, options);
	}
	process.exitCode = exit.code ?? (exit.signal ? 1 : 0);
}

function printWrapHelp() {
	console.log([
		"Usage: pk-speak wrap [options] -- <command> [args...]",
		"",
		"Runs a CLI command and speaks lifecycle notices without capturing the command TTY.",
		"",
		"Options:",
		"  --label <name>             Friendly name to say",
		"  --provider <auto|edge|gemini|elevenlabs|openai|sag|higgs|stable-audio|minimax|legacy>",
		"  --cwd <path>               Working directory for the command",
		"  --shell                    Run through the platform shell",
		"  --capture                  Mirror and classify stdout/stderr",
		"  --capture-bytes <n>        Max output bytes to classify, default 200000",
		"  --no-speak                 Run command without speaking notices",
		"  --no-start                 Skip the start notice",
		"  --allow-open-fallback      If hidden playback fails, open audio with the OS default app",
		"  --gate <orb|immediate|enter>  Playback gate: orb opens the interactive UI (default, no autoplay), enter requires Enter, immediate auto-plays",
		"  --start-text <text>        Override start notice",
		"  --success-text <text>      Override success notice",
		"  --failure-text <text>      Override failure prefix",
		"  --dry-run                  Print the plan without running the command (supported)",
		"",
		"Examples:",
		"  pk-speak wrap -- codex",
		"  pk-speak wrap --label \"Claude Code\" -- claude",
		"  pk-speak wrap --provider sag -- npm test",
		"  pk-speak wrap --capture -- npm test",
		"  pk-speak wrap --no-speak -- node -e \"console.log('ok')\"",
		"  pk-speak wrap --dry-run -- npm test",
	].join("\n"));
}

function printSpeakHelp() {
	console.log([
		"Usage: pk-speak speak [options] [text...]",
		"",
		"Speaks text from command arguments, stdin, or an audio file using the saved pk-speak TTS setup.",
		"",
		"Options:",
		"  --provider <auto|edge|gemini|elevenlabs|openai|sag|higgs|stable-audio|minimax|legacy>",
		"  --input <path>        Transcribe an audio file and speak the transcript",
		"  --audio-input <path>  Alias for --input",
		"  --summarize           Summarize the input text before speaking",
		"  --output <path>       Write audio to a file",
		"  --no-play             Synthesize only; do not play audio",
		"  --no-wait             Return after a detached supervisor starts; it retains temp audio until playback completes",
		"  --allow-open-fallback  If hidden playback fails, open the file with the OS default app",
		"  --gate <orb|immediate|enter>  Playback gate: orb opens the interactive UI (default, no autoplay), enter requires Enter, immediate auto-plays",
		"  --keep                Keep the temp audio file when no --output is supplied",
		"  --rewrite <true|false>",
		"  --dry-run             Print provider and spoken text without synthesis (supported)",
		"",
		"Examples:",
		"  pk-speak speak \"Tests passed\"",
		"  codex exec \"run tests\" | pk-speak speak",
		"  pk-speak speak --input recording.wav",
		"  pk-speak speak --summarize \"Long status message here\"",
		"  pk-speak speak --provider minimax \"Hello from Minimax\"",
		"  pk-speak speak --dry-run \"Tests passed\"",
	].join("\n"));
}

type SpeakCommandOptions = {
	textParts: string[];
	provider?: TtsProvider;
	output?: string;
	noPlay: boolean;
	wait: boolean;
	allowOpenFallback: boolean;
	keep: boolean;
	gate?: SpeakPlaybackGate;
	dryRun: boolean;
	rewrite?: boolean;
	summarize?: boolean;
	input?: string;
	quiet?: boolean;
	help: boolean;
};

type SpeakTextOptions = {
	provider?: TtsProvider;
	output?: string;
	noPlay: boolean;
	allowOpenFallback?: boolean;
	keep: boolean;
	gate?: SpeakPlaybackGate;
	dryRun: boolean;
	rewrite?: boolean;
	quiet?: boolean;
	wait?: boolean;
	signal?: AbortSignal;
};


type WrapCommandOptions = {
	command: string[];
	provider?: TtsProvider;
	cwd?: string;
	label?: string;
	shell: boolean;
	capture: boolean;
	captureBytes: number;
	noSpeak: boolean;
	noStart: boolean;
	allowOpenFallback: boolean;
	gate?: SpeakPlaybackGate;
	dryRun: boolean;
	startText?: string;
	successText?: string;
	failureText?: string;
	help: boolean;
};

function parseSpeakArgs(argv: string[]): SpeakCommandOptions {
	const options: SpeakCommandOptions = {
		textParts: [],
		noPlay: false,
		allowOpenFallback: false,
		wait: true,
		keep: false,
		dryRun: false,
		help: false,
		quiet: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--") {
			options.textParts.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-")) {
			options.textParts.push(arg);
			continue;
		}
		const key = arg.replace(/^-+/, "");
		if (key === "help" || key === "h") {
			options.help = true;
		} else if (key === "provider") {
			options.provider = normalizeTtsProvider(argv[++i]);
		} else if (key === "output" || key === "o") {
			options.output = argv[++i];
		} else if (key === "no-play") {
			options.noPlay = true;
		} else if (key === "no-wait") {
			options.wait = false;
		} else if (key === "allow-open-fallback") {
			options.allowOpenFallback = true;
		} else if (key === "keep") {
			options.keep = true;
		} else if (key === "dry-run") {
			options.dryRun = true;
		} else if (key === "gate" || key === "playback-gate") {
			options.gate = normalizeSpeakPlaybackGate(argv[++i]);
		} else if (key === "rewrite") {
			options.rewrite = boolArg(argv[++i]);
		} else if (key === "summarize") {
			options.summarize = true;
		} else if (key === "input" || key === "audio-input") {
			options.input = argv[++i];
		} else if (key === "quiet") {
			options.quiet = true;
		}
	}
	if (options.output) options.noPlay = options.noPlay || false;
	return options;
}

function parseWrapArgs(argv: string[]): WrapCommandOptions {
	const options: WrapCommandOptions = {
		command: [],
		shell: false,
		capture: false,
		captureBytes: 200_000,
		noSpeak: false,
		noStart: false,
		allowOpenFallback: false,
		dryRun: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--") {
			options.command = argv.slice(i + 1);
			break;
		}
		if (!arg.startsWith("-")) {
			options.command = argv.slice(i);
			break;
		}
		const key = arg.replace(/^-+/, "");
		if (key === "help" || key === "h") {
			options.help = true;
		} else if (key === "provider") {
			options.provider = normalizeTtsProvider(argv[++i]);
		} else if (key === "cwd" || key === "C") {
			options.cwd = argv[++i];
		} else if (key === "label") {
			options.label = argv[++i];
		} else if (key === "shell") {
			options.shell = true;
		} else if (key === "capture") {
			options.capture = true;
		} else if (key === "capture-bytes") {
			options.captureBytes = normalizePositiveInt(argv[++i], options.captureBytes);
		} else if (key === "no-speak") {
			options.noSpeak = true;
		} else if (key === "no-start") {
			options.noStart = true;
		} else if (key === "allow-open-fallback") {
			options.allowOpenFallback = true;
		} else if (key === "gate" || key === "playback-gate") {
			options.gate = normalizeSpeakPlaybackGate(argv[++i]);
		} else if (key === "dry-run") {
			options.dryRun = true;
		} else if (key === "start-text") {
			options.startText = argv[++i];
		} else if (key === "success-text") {
			options.successText = argv[++i];
		} else if (key === "failure-text") {
			options.failureText = argv[++i];
		}
	}
	return options;
}

function normalizeTtsProvider(value: string | undefined): TtsProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "auto"
		|| normalized === "legacy"
		|| normalized === "edge"
		|| normalized === "openai"
		|| normalized === "elevenlabs"
		|| normalized === "gemini"
		|| normalized === "sag"
		|| normalized === "higgs"
		|| normalized === "stable-audio"
		|| normalized === "minimax"
	) {
		return normalized;
	}
	return undefined;
}

function boolArg(value: string | undefined) {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
	return undefined;
}

function normalizePositiveInt(value: string | undefined, fallback: number) {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readStdin() {
	if (process.stdin.isTTY) return "";
	let text = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		text += String(chunk);
	}
	return text;
}


async function speakTextSafely(text: string, options: WrapCommandOptions) {
	await speakText(text, {
		provider: options.provider,
		noPlay: false,
		allowOpenFallback: options.allowOpenFallback,
		keep: false,
		dryRun: false,
		rewrite: false,
		gate: options.gate,
		quiet: true,
		wait: true,
	}).catch((error) => {
		console.error(`pk-speak notice failed: ${error instanceof Error ? error.message : String(error)}`);
	});
}

type CaptureEvent = "approval-needed" | "needs-input" | "tests-failed" | "error";

type CaptureSummary = {
	events: CaptureEvent[];
};

type WrappedProcessResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	capture?: CaptureSummary;
};

function runWrappedProcess(command: string, args: string[], options: WrapCommandOptions) {
	if (options.capture) return runCapturedProcess(command, args, options);
	return new Promise<WrappedProcessResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd || process.cwd(),
			env: buildPiSpeakEnv(),
			stdio: "inherit",
			shell: options.shell,
			windowsHide: false,
		});
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
}

function runCapturedProcess(command: string, args: string[], options: WrapCommandOptions) {
	return new Promise<WrappedProcessResult>((resolve, reject) => {
		let captured = "";
		const appendCapture = (chunk: string) => {
			captured += chunk;
			if (captured.length > options.captureBytes) {
				captured = captured.slice(captured.length - options.captureBytes);
			}
		};
		const child = spawn(command, args, {
			cwd: options.cwd || process.cwd(),
			env: buildPiSpeakEnv(),
			stdio: ["inherit", "pipe", "pipe"],
			shell: options.shell,
			windowsHide: false,
		});
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			const text = String(chunk);
			appendCapture(text);
			process.stdout.write(text);
		});
		child.stderr?.on("data", (chunk) => {
			const text = String(chunk);
			appendCapture(text);
			process.stderr.write(text);
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({
				code,
				signal,
				capture: classifyCapturedOutput(captured, code),
			});
		});
	});
}

function classifyCapturedOutput(output: string, code: number | null): CaptureSummary {
	const normalized = output.replace(/\u001b\[[0-9;]*m/g, "");
	const events: CaptureEvent[] = [];
	const add = (event: CaptureEvent) => {
		if (!events.includes(event)) events.push(event);
	};
	if (/\b(approval|approve|permission|allow|deny|requires approval|confirm command)\b/i.test(normalized)) {
		add("approval-needed");
	}
	if (/\b(enter|input|choose|select|press|continue|confirm|password|passphrase|waiting for)\b|y\/n|yes\/no/i.test(normalized)) {
		add("needs-input");
	}
	if (
		/\b(tests?\s+failed|failures?:|failed\s+\d+|not ok|AssertionError|ERR_ASSERTION|npm ERR!|command failed)\b/i
			.test(normalized)
		|| normalized.includes("✖")
	) {
		add("tests-failed");
	}
	if (/\b(error|exception|traceback|fatal|failed)\b/i.test(normalized) || (code !== null && code > 0)) {
		add("error");
	}
	return { events };
}

function buildWrapFinishMessage(
	exit: WrappedProcessResult,
	label: string,
	successMessage: string,
	failureMessage: string,
) {
	const events = exit.capture?.events || [];
	if (events.includes("approval-needed")) return `${label} appears to need approval.`;
	if (events.includes("needs-input")) return `${label} appears to need input.`;
	if (events.includes("tests-failed")) return `${label} reported test failures.`;
	if (events.includes("error") && exit.code === 0) return `${label} reported errors but exited successfully.`;
	if (exit.code === 0) return successMessage;
	return `${failureMessage} ${exit.code ?? "unknown"}.`;
}

function commandLabel(command: string) {
	const cleaned = command.replace(/^["']|["']$/g, "");
	const parts = cleaned.split(/[\\/]/);
	return parts[parts.length - 1] || cleaned || "command";
}

async function assertDesktopLiveWorkspace(port: number, requestedCwd: string) {
	const url = new URL(`http://127.0.0.1:${port}/v1/workspace`);
	url.searchParams.set("path", requestedCwd);
	const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
	if (!response.ok) throw new Error(`Unable to verify the live workspace (${response.status}).`);
	const payload = await response.json() as { workspace?: { current?: string; root?: string } };
	const actual = payload.workspace?.current ? resolve(payload.workspace.current) : "";
	const requested = resolve(requestedCwd);
	const samePath = process.platform === "win32"
		? actual.toLowerCase() === requested.toLowerCase()
		: actual === requested;
	if (!samePath) {
		throw new Error(`The running gateway is confined to ${payload.workspace?.root || actual || "another workspace"}; restart it for ${requested}.`);
	}
}

async function runNodeScript(scriptPath: string, args: string[], envExtras?: NodeJS.ProcessEnv) {
	if (!existsSync(scriptPath)) {
		if (isDistBuildTarget(scriptPath)) {
			throw new Error(`${scriptPath}: not built — run npm run build`);
		}
		throw new Error(`Command target not found: ${scriptPath}`);
	}
	const child = spawn(process.execPath, [scriptPath, ...args], {
		cwd: process.cwd(),
		env: { ...buildPiSpeakEnv(), ...(envExtras ?? {}) },
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

async function runBrainstormCommand(argv: string[]) {
	const dryRun = hasFlag(argv, "dry-run");
	const wantsHelp = hasFlag(argv, "help") || hasFlag(argv, "h");
	const positional = stripMetaFlags(argv).filter((arg) => !arg.startsWith("-"));

	if (wantsHelp || positional.length < 1) {
		console.log([
			"Usage: pk-speak brainstorm <audio-file-path> [--dry-run]",
			"",
			"Transcribes a brainstorm/word-vomit session using WhisperX and structures it into a markdown document.",
			"",
			"Options:",
			"  --dry-run     Print the resolved plan without reading the audio file or calling the gateway",
			"  -h, --help    Show this help",
			"",
			"Examples:",
			"  pk-speak brainstorm --help",
			"  pk-speak brainstorm recording.wav --dry-run",
			"  pk-speak brainstorm recording.wav",
		].join("\n"));
		if (!wantsHelp && positional.length < 1) {
			process.exitCode = dryRun ? 0 : 1;
		}
		return;
	}

	const filePath = resolve(positional[0]);
	const config = loadPiSpeakSetupConfig();
	const port = config.httpPort || process.env.PI_SPEAK_HTTP_PORT || "8767";
	const token = config.httpToken || process.env.PI_SPEAK_HTTP_TOKEN || "";
	const host = process.env.PI_SPEAK_HTTP_HOST || "127.0.0.1";

	if (dryRun) {
		console.log("dry-run: pk-speak brainstorm");
		console.log(`Audio file: ${filePath}`);
		console.log(`Exists: ${existsSync(filePath) ? "yes" : "no"}`);
		console.log(`Would POST to: http://${host}:${port}/v1/brainstorm`);
		console.log(`Authorization: ${token ? "Bearer <configured>" : "none"}`);
		console.log("Would not read the audio payload, open network ports, write files, or play audio");
		return;
	}

	if (!existsSync(filePath)) {
		console.error(`Audio file not found: ${filePath}`);
		process.exitCode = 1;
		return;
	}

	const fileBuffer = await import("node:fs/promises").then(m => m.readFile(filePath));
	const mimeType = filePath.endsWith(".wav") ? "audio/wav"
		: filePath.endsWith(".mp3") ? "audio/mpeg"
		: filePath.endsWith(".m4a") ? "audio/mp4"
		: filePath.endsWith(".webm") ? "audio/webm"
		: "application/octet-stream";

	console.log(`Sending brainstorm recording (${Math.round(fileBuffer.length / 1024)} KB) to gateway at http://${host}:${port}...`);
	try {
		const response = await fetch(`http://${host}:${port}/v1/brainstorm`, {
			method: "POST",
			headers: {
				"Content-Type": mimeType,
				"Authorization": token ? `Bearer ${token}` : "",
			},
			body: fileBuffer,
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Gateway returned status ${response.status}: ${errText}`);
		}

		const result = (await response.json()) as { ok: boolean; text?: string; formatted?: string; filePath?: string; error?: string };
		if (!result.ok) {
			throw new Error(result.error || "Brainstorming failed at gateway");
		}

		console.log("\n--- Brainstorm Processed Successfully ---");
		console.log(`Saved output file to: ${result.filePath}`);
		console.log("\nRaw Transcript Preview:");
		console.log(result.text?.slice(0, 300) + (result.text && result.text.length > 300 ? "..." : ""));
		console.log("\nStructured Markdown Output Preview:");
		console.log(result.formatted?.slice(0, 500) + (result.formatted && result.formatted.length > 500 ? "..." : ""));
	} catch (error) {
		console.error(`Brainstorm command failed: ${error instanceof Error ? error.message : String(error)}`);
		console.error("Please make sure the pk-speak gateway is running (run 'pk-speak gateway' first).");
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
