#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiSpeakEnv, getPiSpeakSetupConfigPath, loadPiSpeakSetupConfig, maskSecret } from "./setup-config.js";
import { resolveTtsProvider, sanitizeForSpeech, synthesizeToFile, type TtsProvider } from "./tts.js";
import {
	describeSpeakPlaybackGate,
	normalizeSpeakPlaybackGate,
	resolveSpeakPlaybackGate,
	waitForSpeakPlaybackGate,
	type SpeakPlaybackGate,
} from "./speak-gate.js";
import { getRealtimeTerminalAuditPath } from "./realtime-terminal-audit.js";

type Args = Record<string, string | boolean>;

const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIST_DIR, "..");

async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const command = String(args._ || "help").toLowerCase();
	if (command === "help" || ((args.help || args.h) && !args._)) {
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
	if (command === "speak" || command === "say") {
		await runSpeakCommand(argv.slice(1));
		return;
	}
	if (command === "wrap") {
		await runWrapCommand(argv.slice(1));
		return;
	}
	if (command === "brainstorm" || command === "bs") {
		await runBrainstormCommand(argv.slice(1));
		return;
	}
	if (command === "gateway" || command === "serve") {
		const gatewayArgs = argv.slice(1);
		const liveMode = gatewayArgs.includes("--live");
		const passthrough = gatewayArgs.filter((arg) => arg !== "--live");
		await runNodeScript(
			join(DIST_DIR, "headless-gateway.js"),
			passthrough,
			liveMode ? { AGENT_PROVIDER: "gemini-live" } : undefined,
		);
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
		"  speak       Speak text from args or stdin using configured TTS",
		"  wrap        Run a CLI command and speak start/finish notices",
		"  brainstorm  Transcribe brainstorm audio using WhisperX and structure it",
		"  gateway     Start the headless phone/control gateway (add --live for Gemini Live barge-in)",
		"  tray        Start the Windows tray controller and gateway",
		"  mobile      Print the Android setup/download QR",
		"  admin       Open the sessions admin pane",
		"  config      Show the saved setup profile path and masked values",
		"",
		"Typical flow:",
		"  pi-speak-pk",
		"  pk-speak tray",
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

function printDoctor() {
	const config = loadPiSpeakSetupConfig();
	const configPath = getPiSpeakSetupConfigPath();
	const elevenLabsEnv = describeSecretSource("ELEVENLABS_API_KEY", config.elevenLabsApiKey);
	console.log("pk-speak doctor");
	console.log(`Config: ${existsSync(configPath) ? configPath : "not found; run pi-speak-pk"}`);
	console.log(`Package root: ${ROOT}`);
	console.log(`Agent provider: ${config.agentProvider || process.env.AGENT_PROVIDER || "codex"}`);
	console.log(`Voice router: ${config.executionRouterMode || process.env.PI_SPEAK_EXECUTION_ROUTER_MODE || "auto"}`);
	console.log(`TTS provider: ${config.ttsProvider || process.env.PI_SPEAK_TTS_PROVIDER || "edge"}`);
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

	const text = (options.textParts.join(" ") || await readStdin()).trim();
	if (!text) {
		console.error("No text provided. Pass text as arguments or pipe it on stdin.");
		printSpeakHelp();
		process.exitCode = 1;
		return;
	}

	await speakText(text, options);
}

async function speakText(text: string, options: SpeakTextOptions) {
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
		});
		if (!options.quiet) {
			console.log(`Spoke with ${result.provider}${result.rewriteApplied ? " (rewritten)" : ""}: ${outputPath}`);
		}
		if (!options.noPlay) {
			const gate = resolveSpeakPlaybackGate({ cliGate: options.gate, env: process.env, config: loadPiSpeakSetupConfig() });
			const gateResult = await waitForSpeakPlaybackGate(gate);
			if (gateResult === "skipped") {
				console.warn(`pk-speak playback gated (${describeSpeakPlaybackGate(gate)}) but stdin is not interactive; audio left at ${outputPath}.`);
				removeTempDir = false;
				return;
			}
			const playback = await playAudioFile(outputPath, { allowOpenFallback: options.allowOpenFallback });
			if (playback === "opened") removeTempDir = false;
		}
	} finally {
		if (tempDir && removeTempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	}
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
		"  --provider <auto|edge|elevenlabs|openai|sag|higgs|stable-audio|legacy>",
		"  --cwd <path>               Working directory for the command",
		"  --shell                    Run through the platform shell",
		"  --capture                  Mirror and classify stdout/stderr",
		"  --capture-bytes <n>        Max output bytes to classify, default 200000",
		"  --no-speak                 Run command without speaking notices",
		"  --no-start                 Skip the start notice",
		"  --allow-open-fallback      If hidden playback fails, open audio with the OS default app",
		"  --gate <immediate|enter>    Require Enter before speaking notices",
		"  --start-text <text>        Override start notice",
		"  --success-text <text>      Override success notice",
		"  --failure-text <text>      Override failure prefix",
		"  --dry-run                  Print the plan without running the command",
		"",
		"Examples:",
		"  pk-speak wrap -- codex",
		"  pk-speak wrap --label \"Claude Code\" -- claude",
		"  pk-speak wrap --provider sag -- npm test",
		"  pk-speak wrap --capture -- npm test",
		"  pk-speak wrap --no-speak -- node -e \"console.log('ok')\"",
	].join("\n"));
}

function printSpeakHelp() {
	console.log([
		"Usage: pk-speak speak [options] [text...]",
		"",
		"Speaks text from command arguments or stdin using the saved pk-speak TTS setup.",
		"",
		"Options:",
		"  --provider <auto|edge|elevenlabs|openai|sag|legacy>",
		"  --output <path>       Write audio to a file",
		"  --no-play             Synthesize only; do not play audio",
		"  --allow-open-fallback  If hidden playback fails, open the file with the OS default app",
		"  --gate <immediate|enter>  Require Enter before playing audio",
		"  --keep                Keep the temp audio file when no --output is supplied",
		"  --rewrite <true|false>",
		"  --dry-run             Print provider and spoken text without synthesis",
		"",
		"Examples:",
		"  pk-speak speak \"Tests passed\"",
		"  codex exec \"run tests\" | pk-speak speak",
		"  pk-speak speak --provider sag \"I need approval\"",
	].join("\n"));
}

type SpeakCommandOptions = {
	textParts: string[];
	provider?: TtsProvider;
	output?: string;
	noPlay: boolean;
	allowOpenFallback: boolean;
	keep: boolean;
	gate?: SpeakPlaybackGate;
	dryRun: boolean;
	rewrite?: boolean;
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
		keep: false,
		dryRun: false,
		help: false,
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
		|| normalized === "sag"
		|| normalized === "higgs"
		|| normalized === "stable-audio"
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

async function playAudioFile(filePath: string, options: { allowOpenFallback?: boolean } = {}): Promise<"played" | "opened" | "skipped"> {
	if (process.platform === "win32") {
		// Prefer a headless CLI player when available (ffplay/mpg123/mpv). It is far more
		// reliable than the WPF MediaPlayer fallback, which fails on headless/agent shells.
		const winPlayer = getWindowsAudioPlayer();
		if (winPlayer) {
			try {
				await runProcess(winPlayer, getAudioPlayerArgs(winPlayer, filePath));
				return "played";
			} catch {
				// Fall through to the PowerShell MediaPlayer method below.
			}
		}
		try {
			await runProcess(
				"powershell.exe",
				[
					"-NoProfile",
					"-Sta",
					"-Command",
					[
						"$ErrorActionPreference = 'Stop'",
						"$path = (Resolve-Path -LiteralPath $env:PK_SPEAK_AUDIO_PATH).Path",
						"Add-Type -AssemblyName PresentationCore",
						"$player = New-Object System.Windows.Media.MediaPlayer",
						"$player.Open([Uri]::new($path))",
						"$player.Play()",
						"$limit = (Get-Date).AddSeconds(120)",
						"while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $limit) { Start-Sleep -Milliseconds 50 }",
						"if ($player.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds) + 250) } else { Start-Sleep -Seconds 2 }",
						"$player.Close()",
					].join("; "),
				],
				{ env: { ...process.env, PK_SPEAK_AUDIO_PATH: filePath } },
			);
			return "played";
		} catch (error) {
			if (options.allowOpenFallback) {
				await runProcess("cmd.exe", ["/c", "start", "", filePath]);
				return "opened";
			}
			console.warn(`pk-speak playback skipped: hidden Windows audio failed (${error instanceof Error ? error.message : String(error)}).`);
			return "skipped";
		}
	}
	const command = getUnixAudioPlayer(options.allowOpenFallback);
	if (!command) {
		console.warn("pk-speak playback skipped: no headless audio player found. Use --allow-open-fallback to open the audio file with the OS default app.");
		return "skipped";
	}
	await runProcess(command, getAudioPlayerArgs(command, filePath));
	return command === "xdg-open" ? "opened" : "played";
}

function getUnixAudioPlayer(allowOpenFallback?: boolean) {
	if (process.platform === "darwin") return "afplay";
	for (const command of ["paplay", "mpg123", "ffplay"]) {
		if (existsOnPath(command)) return command;
	}
	return allowOpenFallback ? "xdg-open" : undefined;
}

function getWindowsAudioPlayer() {
	for (const command of ["ffplay", "mpg123", "mpv"]) {
		if (existsOnPath(command)) return command;
	}
	return undefined;
}

function getAudioPlayerArgs(command: string, filePath: string) {
	if (command === "ffplay") return ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath];
	if (command === "mpv") return ["--no-video", "--really-quiet", filePath];
	return [filePath];
}

function existsOnPath(command: string) {
	const isWin = process.platform === "win32";
	const pathDirs = (process.env.PATH || "").split(isWin ? ";" : ":");
	const exts = isWin
		? [...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.trim()).filter(Boolean), ""]
		: [""];
	return pathDirs.some((dir) => dir && exts.some((ext) => existsSync(join(dir, command + ext))));
}

function runProcess(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true,
			env: options.env ?? process.env,
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited with code ${code}`));
		});
	});
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

async function runNodeScript(scriptPath: string, args: string[], envExtras?: NodeJS.ProcessEnv) {
	if (!existsSync(scriptPath)) {
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
	if (argv.length < 1 || argv[0].startsWith("-")) {
		console.log([
			"Usage: pk-speak brainstorm <audio-file-path>",
			"",
			"Transcribes a brainstorm/word-vomit session using WhisperX and structures it into a markdown document.",
		].join("\n"));
		return;
	}

	const filePath = resolve(argv[0]);
	if (!existsSync(filePath)) {
		console.error(`Audio file not found: ${filePath}`);
		process.exitCode = 1;
		return;
	}

	const config = loadPiSpeakSetupConfig();
	const port = config.httpPort || process.env.PI_SPEAK_HTTP_PORT || "8767";
	const token = config.httpToken || process.env.PI_SPEAK_HTTP_TOKEN || "";
	const host = process.env.PI_SPEAK_HTTP_HOST || "127.0.0.1";

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
