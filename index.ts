import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { spawnDetached } from "./spawn-shim.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import QRCode from "qrcode";
import { ControlServer, type ControlActionResult, type ControlServerState, type GatewayAgentProvider, type RemoteSlashCommand, type SessionLaunchPayload, type SessionRenamePayload, type SessionAliasPayload, type SessionRemovePayload } from "./control-server.js";
import { publishOwnerHubSession, resumeOwnerHubSession } from "./hub-handoff.js";
import { sendHerdrPane } from "./herdr-client.js";
import { TelegramPhoneBridge, type PhoneBridgeState } from "./phone-bridge.js";
import { BusyError, RemoteTurnManager, type ConversationExecutionPlan, type ConversationReducerSummary, type RemoteTurnResult, type TurnProgressEvent, type TurnTimingSummary } from "./remote-turn-manager.js";
import { shutdownLocalSttWorker, transcribeAudioBuffer } from "./stt.js";
import { requestGracefulChildShutdown } from "./listener-control.js";
import { findSessionRouteConflict, isSpeechInterruptCommand, listKnownTargets, resolveSessionRoute, resolveSessionTarget } from "./voice-routing.js";
import { isAffirmative, isNegative } from "./voice-confirmation.js";
import { createApprovalRegistry } from "./voice-approval.js";
import { extractDiff, extractErrors, parsePlaybackCommand } from "./voice-playback.js";
import {
	buildSessionDashboard,
	buildCompactRouteSlots,
	clearWakeAlias,
	describeSessionRoutingStore,
	findSessionNameByPath,
	formatCompactRouteSlots,
	formatSessionManagerSummary,
	removeSessionRoutingForPath,
	setNamedSession,
	setWakeAlias,
} from "./session-routing.js";
import { buildOhMyPiAgentHubDashboardCached, mergeOhMyPiAgentHubSessions } from "./agent-hub-dashboard.js";
import { archiveOhMyPiBackgroundSession, buildColabLaunchPlan, buildOhMyPiLaunchArgv, normalizeOptionalString, recoverOhMyPiBackgroundSession, validateOmpSelection } from "./agent-hub-actions.js";
import { createLiveAgentHubBinding } from "./herdr-agent-hub-live.js";
import { getSessionRoutingStorePath, loadPersistedSessionRouting, persistSessionRouting } from "./session-routing-store.js";
import { appendSessionEvent, tailSessionEvents, type SessionEventSource } from "./session-events.js";
import { clearRootVoiceDisable, enableRootVoiceDisable, isRootVoiceDisabled } from "./pairing.js";
import { launchSessionManagerPane } from "./ui-launcher.js";
import { parseVoiceSlashCommand } from "./voice-session-command.js";
import { discoverAgentInventoryCached, discoverOpenAgentTargetsCached, resolveWindowsNpmShim } from "./agent-discovery.js";
import { handleRealtimeGateway } from "./realtime-gateway.js";
import { buildSessionWorkingDirectoryMap } from "./session-working-directory.js";
import { getPythonCommand, getSpeakInvocationFromEnv } from "./runtime-paths.js";
import { collectAgentResponse, resolveAgentProviderConfig, type AgentProvider } from "./agent-provider.js";
import { PiAgentProvider } from "./pi-agent-provider.js";
import { CodexAgentProvider } from "./codex-agent-provider.js";
import { ClaudeAgentProvider } from "./claude-agent-provider.js";
import { createOmpAgentProvider, createOmpResumeProvider } from "./agent-provider-factory.js";
import { OmpSelectionStore } from "./omp-selection.js";
import {
	appendExecutionTrace,
	type ExecutionDecision,
	type ExecutionPlanReplay,
} from "./conversation-execution-trace.js";
import { startRemoteTray, type RemoteTrayRuntime } from "./tray-controller.js";
import { reduceConversationTurn } from "./conversation-reducer.js";
import { planConversationExecution } from "./conversation-execution-router.js";
import {
	describeTtsProvider,
	getAudioMimeType,
	getTtsDiagnostics,
	isRewriteEnabled,
	resolveTtsProvider,
	synthesizeToFile,
	type SpeakRuntimeState,
	type TtsProvider,
} from "./tts.js";
import { readAttentionSnapshots } from "./attention-broker.js";
import { isGeminiLiveConfigured, runGeminiLiveTurn } from "./gemini-live-turn.js";

type SpeakState = SpeakRuntimeState & {
	enabled: boolean;
};

type MonoState = {
	listening: boolean;
};

type SessionRegistryState = {
	sessions: Record<string, string>; // name -> sessionPath
};

type SessionWakeAliasState = {
	aliases: Record<string, string>; // alias -> sessionPath
};

function normalizeGatewayProviderOverride(value: string | undefined): GatewayAgentProvider | undefined {
	const normalized = (value || "").trim().toLowerCase();
	if (normalized === "pi" || normalized === "codex" || normalized === "claude") return normalized;
	if (normalized === "oh-my-pk" || normalized === "ompk" || normalized === "oh-my-pi" || normalized === "omp") return "oh-my-pk";
	return undefined;
}

type RemoteState = ControlServerState & {
	defaultTarget?: string;
};

type PendingRemoteTurn = {
	resolve: (result: RemoteTurnResult) => void;
	reject: (error: Error) => void;
	transcript?: string;
	wantAudio?: boolean;
	timings?: TurnTimingSummary;
	providers?: {
		stt?: string;
		tts?: string;
	};
	warnings?: string[];
	timeoutId?: NodeJS.Timeout;
};

type ListenerEvent =
	| { type: "wake"; state: "on" | "off" | "ping"; reason?: string; target?: string }
	| { type: "speech"; text: string }
	| { type: "transcribing" }
	| { type: "status"; message: string }
	| { type: "error"; message: string };

type ContentBlock = {
	type?: string;
	text?: string;
};

type RuntimeDiagnostics = {
	lastErrors: {
		listener?: string;
		phone?: string;
		remote?: string;
		stt?: string;
		tts?: string;
	};
	recentTimings: {
		lastRemoteTurn?: TurnTimingSummary;
		lastRemoteSource?: string;
	};
	listener: {
		lastStatus?: string;
		lastStartedAt?: number;
		lastExitedAt?: number;
	};
};

const STATE_TYPE = "elevenlabs-speak-state";
const MONO_STATE_TYPE = "mono-listener-state";
const PHONE_STATE_TYPE = "phone-bridge-state";
const REMOTE_STATE_TYPE = "remote-control-state";
const SESSION_REGISTRY_TYPE = "session-registry";
const SESSION_WAKE_ALIAS_TYPE = "session-wake-aliases";
const SESSION_REMOVE_CONFIRM_TTL_MS = Number.parseInt(process.env.PI_SPEAK_SESSION_REMOVE_CONFIRM_TTL_MS || "120000", 10);
const AVAILABLE_TTS_PROVIDERS: TtsProvider[] = ["auto", "legacy", "gemini", "elevenlabs", "openai", "edge", "sag", "higgs", "stable-audio"];
const MONO_KEEP_ALIVE_SECONDS = Number.parseFloat(
	process.env.PI_SPEAK_MONO_ACTIVITY_TIMEOUT || process.env.MONO_ACTIVITY_TIMEOUT || "15",
);
const MONO_WAKE_PHRASE = process.env.PI_SPEAK_WAKE_PHRASE || process.env.PI_SPEAK_MONO_WAKE_PHRASE || "PK";
const PHONE_TURN_WAIT_TIMEOUT_MS = Number.parseInt(process.env.PI_SPEAK_PHONE_WAIT_TIMEOUT_MS || "180000", 10);
const DEFAULT_REMOTE_HOST = process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0";
const DEFAULT_REMOTE_PORT = Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10);
const DEFAULT_ADB_REMOTE_HOST = process.env.PI_SPEAK_ADB_HTTP_HOST || "127.0.0.1";
const DEFAULT_ADB_REMOTE_PORT = Number.parseInt(process.env.PI_SPEAK_ADB_HTTP_PORT || "8787", 10);
const PUBLIC_REMOTE_BASE_URL = process.env.PI_SPEAK_PUBLIC_BASE_URL?.trim() || "";
const DEFAULT_REMOTE_AUTH_TOKEN = process.env.PI_SPEAK_HTTP_TOKEN || getOrCreateInstallAuthToken();
const DEFAULT_AGENT_CWD = process.env.AGENT_CWD?.trim()
	|| process.env.AGENT_WORKSPACE?.trim()
	|| process.cwd();
const REMOTE_SLASH_COMMANDS: RemoteSlashCommand[] = [
	{
		name: "speak",
		description: "Enable spoken assistant replies and choose the TTS provider",
		usage: "/speak [on|off|stop|status|test|providers|provider <name>|rewrite on|rewrite off]",
		examples: ["/speak on", "/speak status", "/speak provider edge"],
		source: "extension",
	},
	{
		name: "mono",
		description: "Control the always-on PK wake listener",
		usage: "/mono [on|off|status]",
		examples: ["/mono on", "/mono status"],
		source: "extension",
	},
	{
		name: "sess",
		description: "Manage named sessions, wake aliases, slot lanes, and routing summaries",
		usage: "/sess [new|switch|rename|edit|alias|remove|launch|list|name|wake|slots|ui|export] <args>",
		examples: ["/sess", "/sess slots", "/sess launch colab", "/sess switch one"],
		source: "extension",
	},
	{
		name: "skills",
		description: "List and search installed agent skills from the generated Codex skill index",
		usage: "/skills [list|search <query>|show <name>]",
		examples: ["/skills", "/skills search android", "/skills show android-development"],
		source: "builtin",
	},
	{
		name: "model",
		description: "Show the gateway default model and the model override sent by this app",
		usage: "/model",
		examples: ["/model"],
		source: "builtin",
	},
	{
		name: "phone",
		description: "Configure the Telegram phone bridge",
		usage: "/phone [on|off|status|setup|token <bot-token>|code|unpair]",
		examples: ["/phone setup", "/phone status", "/phone code"],
		source: "extension",
	},
	{
		name: "remote",
		description: "Control the local HTTP API used by phone remotes and automations",
		usage: "/remote [on|off|status|token|setup|setup bluetooth|tray on|tray off|tray status]",
		examples: ["/remote on", "/remote setup", "/remote status"],
		source: "extension",
	},
	{
		name: "pk-remote",
		description: "Start the phone remote and show Android setup QR details",
		usage: "/pk-remote [bluetooth]",
		examples: ["/pk-remote", "/pk-remote bluetooth"],
		source: "extension",
	},
	{
		name: "pk-speak",
		description: "Hard-stop or control pk-speak voice replies and the wake listener",
		usage: "/pk-speak [stop|off|quiet|silence|shush|on|status]",
		examples: ["/pk-speak stop", "/pk-speak status", "/pk-speak off", "/pk-speak quiet"],
		source: "extension",
	},
	{
		name: "pk-remote-launch",
		description: "Start the phone remote and automatically supervise ADB reverse port forwarding",
		usage: "/pk-remote-launch [bluetooth]",
		examples: ["/pk-remote-launch", "/pk-remote-launch bluetooth"],
		source: "extension",
	},
];
const PI_SPEAK_REDUCER_MIN_CONFIDENCE = Number.isFinite(
	Number.parseFloat(process.env.PI_SPEAK_REDUCER_MIN_CONFIDENCE || "0.45"),
)
	? Number.parseFloat(process.env.PI_SPEAK_REDUCER_MIN_CONFIDENCE || "0.45")
	: 0.45;
const DEFAULT_VOICE = "adam";

function getOrCreateInstallAuthToken() {
	const tokenFile = getInstallAuthTokenPath();
	try {
		const existing = readFileSync(tokenFile, "utf8").trim();
		if (existing.length >= 24) return existing;
	} catch {
		// Generate below.
	}
	const token = randomBytes(32).toString("base64url");
	try {
		mkdirSync(dirname(tokenFile), { recursive: true });
		writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// State sync still persists the generated token when filesystem config is unavailable.
	}
	return token;
}

function getInstallAuthTokenPath() {
	const base = process.env.PI_SPEAK_CONFIG_DIR
		|| process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "pi-speak")
		|| process.env.APPDATA && join(process.env.APPDATA, "pi-speak")
		|| join(process.cwd(), ".pi-speak");
	return join(base, "http-token");
}

type SkillIndexEntry = {
	name: string;
	summary: string;
	source?: string;
	path?: string;
};

function readSkillIndexEntries(): SkillIndexEntry[] {
	const skillIndexPath = join(homedir(), ".codex", "skill-index.md");
	let raw = "";
	try {
		raw = readFileSync(skillIndexPath, "utf8");
	} catch {
		return [];
	}
	return raw
		.split(/\r?\n## /)
		.slice(1)
		.map((section) => {
			const lines = section.split(/\r?\n/);
			const name = (lines.shift() || "").trim();
			const summaryLines: string[] = [];
			let source: string | undefined;
			let path: string | undefined;
			let readingSummary = true;
			for (const line of lines) {
				if (line.startsWith("- ")) readingSummary = false;
				if (readingSummary) {
					const cleaned = line.replace(/^>\s?-?\s?/, "").trim();
					if (cleaned) summaryLines.push(cleaned);
				}
				if (line.startsWith("- source:")) source = line.slice("- source:".length).trim();
				if (line.startsWith("- path:")) path = line.slice("- path:".length).trim();
			}
			return {
				name,
				summary: summaryLines.join(" ").trim(),
				source,
				path,
			};
		})
		.filter((entry) => entry.name && entry.path);
}

function formatSkillEntry(entry: SkillIndexEntry) {
	const summary = entry.summary || entry.source || "No summary in the generated index.";
	return `/${entry.name} - ${summary}`;
}

function handleSkillsSlashCommand(args: string[]): string {
	const entries = readSkillIndexEntries();
	if (entries.length === 0) {
		return "No generated skill index was found at ~/.codex/skill-index.md. Run the skill index refresh, then try /skills again.";
	}
	const action = (args[0] || "list").toLowerCase();
	if (action === "show") {
		const name = args.slice(1).join(" ").trim().toLowerCase();
		if (!name) return "Usage: /skills show <name>";
		const entry = entries.find((candidate) => candidate.name.toLowerCase() === name);
		if (!entry) return `No installed skill named "${name}" was found. Try /skills search ${name}.`;
		return [
			`Skill: ${entry.name}`,
			entry.summary || "No summary in the generated index.",
			entry.source ? `Source: ${entry.source}` : undefined,
			entry.path ? `Path: ${entry.path}` : undefined,
		].filter(Boolean).join("\n");
	}
	const query = action === "search" ? args.slice(1).join(" ").trim().toLowerCase() : "";
	const matches = query
		? entries.filter((entry) => `${entry.name} ${entry.summary} ${entry.source || ""}`.toLowerCase().includes(query))
		: entries;
	const shown = matches.slice(0, 12);
	const header = query
		? `Skills matching "${query}" (${shown.length}/${matches.length} shown):`
		: `Installed skills (${shown.length}/${entries.length} shown):`;
	return [header, ...shown.map(formatSkillEntry)].join("\n");
}

function handleGatewaySlashCommand(
	trimmed: string,
	options: { model?: string; defaultModel?: string; cwd?: string; agentProvider?: GatewayAgentProvider },
): RemoteTurnResult | undefined {
	if (!trimmed.startsWith("/")) return undefined;
	const [rawCommand, ...args] = trimmed.slice(1).split(/\s+/);
	const command = rawCommand.toLowerCase();
	if (command === "skills") {
		return { replyText: handleSkillsSlashCommand(args) };
	}
	if (command === "model") {
		return {
			replyText: [
				`App model override: ${options.model || "server default"}.`,
				`Gateway default model: ${options.defaultModel || "not set"}.`,
				`Provider: ${options.agentProvider || "auto"}.`,
				options.cwd ? `Working directory: ${options.cwd}.` : undefined,
			].filter(Boolean).join("\n"),
		};
	}
	return undefined;
}

const SPEECH_MODE_PROMPT = `Activate CodeChat mode for this conversation.

Speech pipeline for this session:
1. The user submits text.
2. Pi generates the full assistant response for the UI.
3. The spoken version may be lightly rewritten for audio clarity.
4. The spoken version is synthesized by the configured TTS provider.

Core behavior:
- Be highly conversational, concise, and easy to follow when heard out loud.
- Prefer short paragraphs over lists unless lists are clearly better.
- Avoid markdown tables unless I explicitly ask for one.
- Do not read or emphasize full file paths unless absolutely necessary. Prefer filenames, folder names, or short relative locations.
- Translate raw command output, stack traces, JSON, diffs, and logs into plain English first.
- When discussing code, start with the high-level purpose, then the important details, then next actions.
- Build context progressively: first explain what the repo or feature seems to do, then zoom into the relevant files and functions.
- Prefer README, docs, AGENTS.md, CLAUDE.md, specs, plans, and nearby source before going broad.
- If you need to inspect code, use tools and summarize what you found in a speech-friendly way.
- If you want to make changes, first explain the intent in one or two plain-English sentences.
- For dangerous or irreversible actions, explicitly ask for approval before proceeding.
- When the user asks follow-up questions, keep continuity and act like you are talking about the same codebase live.

Response style:
- Sound like a smart teammate talking, not a report generator.
- Keep answers tight by default and expand only when useful.
- Mention filenames and functions naturally, like â€œin speak11.pyâ€ or â€œthe listen function,â€ instead of long path strings.
- End with the clearest next useful point or question.`;

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is ContentBlock => !!part && typeof part === "object")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!.trim())
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

function getSpeakInvocation(outputPath: string) {
	return getSpeakInvocationFromEnv(outputPath, DEFAULT_VOICE, process.env);
}

function getPlayerInvocation(filePath: string) {
	const escaped = filePath.replace(/\\/g, "\\\\");
	const ps = `
Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]::new("${escaped}"))
Start-Sleep -Milliseconds 250
$player.Play()
while ($player.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }
$duration = [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds)
Start-Sleep -Milliseconds ($duration + 1200)
$player.Stop()
$player.Close()
`;
	return { command: "powershell.exe", args: ["-NoProfile", "-Command", ps] };
}

function normalizeBaseUrl(value: string) {
	return value.endsWith("/") ? value : `${value}/`;
}

function isPrivateLanIpv4(address: string) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailscaleIpv4(address: string) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function getReachableIpv4Addresses() {
	const tailscale: string[] = [];
	const lan: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries || []) {
			if (entry.family !== "IPv4" || entry.internal) continue;
			if (isTailscaleIpv4(entry.address)) {
				tailscale.push(entry.address);
			} else if (isPrivateLanIpv4(entry.address)) {
				lan.push(entry.address);
			}
		}
	}
	return {
		tailscale: [...new Set(tailscale)],
		lan: [...new Set(lan)],
	};
}

function isTruthy(value: string | undefined | null) {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getDefaultTailscaleBaseUrl(port: number) {
	const configured =
		process.env.PI_SPEAK_TRAY_BASE_URL?.trim() ||
		process.env.PI_SPEAK_TAILSCALE_BASE_URL?.trim() ||
		process.env.PI_SPEAK_PUBLIC_BASE_URL?.trim();
	if (configured) return normalizeBaseUrl(configured);
	const detected = getReachableIpv4Addresses().tailscale[0];
	if (detected) return `http://${detected}:${port}/`;
	return `http://127.0.0.1:${port}/`;
}

function getDefaultBluetoothBaseUrl(port: number) {
	const configured = process.env.PI_SPEAK_BLUETOOTH_BASE_URL?.trim();
	if (configured) return normalizeBaseUrl(configured);
	const detected = getReachableIpv4Addresses().lan[0];
	return `http://${detected || "127.0.0.1"}:${port}/`;
}

function getSetupProfileForBaseUrl(baseUrl: string, mode: "tailscale" | "bluetooth" = "tailscale") {
	if (mode === "bluetooth") {
		return { machineId: "bluetooth-local", profileName: "Bluetooth / local link", connectionMode: "bluetooth" };
	}
	if (baseUrl.includes("192.168.") || baseUrl.includes("10.") || /172\.(1[6-9]|2\d|3[01])\./.test(baseUrl)) {
		return { machineId: "local-lan", profileName: "Local network", connectionMode: "manual" };
	}
	return { machineId: "tailscale", profileName: "Tailscale", connectionMode: "tailscale" };
}

function buildRemoteSetupUrls(
	host: string,
	port: number,
	token: string,
	mode: "tailscale" | "bluetooth" = "tailscale",
	agentProvider?: string,
	defaultTarget?: string,
	agentModel?: string,
) {
	const publicBase = PUBLIC_REMOTE_BASE_URL ? normalizeBaseUrl(PUBLIC_REMOTE_BASE_URL) : "";
	const fallbackBase = getDefaultTailscaleBaseUrl(port);
	const bluetoothBase = getDefaultBluetoothBaseUrl(port);
	const detected = getReachableIpv4Addresses();
	const tailscaleBases = detected.tailscale.map((address) => `http://${address}:${port}/`);
	const lanBases = detected.lan.map((address) => `http://${address}:${port}/`);
	const hostBase = host && host !== "0.0.0.0" && host !== "::" && (isTailscaleIpv4(host) || isPrivateLanIpv4(host))
		? `http://${host}:${port}/`
		: "";
	const baseUrls = mode === "bluetooth"
		? [...new Set([bluetoothBase].filter(Boolean))]
		: [...new Set([publicBase, ...tailscaleBases, hostBase, ...lanBases, fallbackBase].filter(Boolean))];
	const browserUrls = baseUrls.map((baseUrl) => `${baseUrl}app/?token=${encodeURIComponent(token)}`);
	const setupPageUrls = baseUrls.map((baseUrl) => `${baseUrl}setup?token=${encodeURIComponent(token)}`);
	const downloadUrls = baseUrls.map((baseUrl) => `${baseUrl}download/pi-speak.apk`);
	const appSetupUrls = baseUrls.map((baseUrl) => {
		const profile = getSetupProfileForBaseUrl(baseUrl, mode);
		const params = new URLSearchParams({
			base_url: baseUrl,
			token,
			machine_id: profile.machineId,
			profile_name: profile.profileName,
			connection_mode: profile.connectionMode,
		});
		if (agentProvider) {
			params.set("agent_provider", agentProvider);
		}
		if (agentModel) {
			params.set("agent_model", agentModel);
		}
		if (defaultTarget) {
			params.set("default_target", defaultTarget);
		}
		params.set("workspace_root", DEFAULT_AGENT_CWD || process.cwd());
		params.set("workspace_path", DEFAULT_AGENT_CWD || process.cwd());
		return `pi-speak://setup?${params.toString()}`;
	});
	return { baseUrls, browserUrls, setupPageUrls, downloadUrls, appSetupUrls };
}

async function buildRemoteSetupQrText(url: string) {
	if (!url) return "";
	return QRCode.toString(url, {
		type: "terminal",
		small: true,
		margin: 1,
		errorCorrectionLevel: "M",
	});
}

function playMonoCue(kind: "listening" | "idle" = "listening") {
	const ps = kind === "listening"
		? "[console]::Beep(1046,120); Start-Sleep -Milliseconds 40; [console]::Beep(1318,160)"
		: "[console]::Beep(784,100)";
	return spawn("powershell.exe", ["-NoProfile", "-Command", ps], {
		stdio: "ignore",
		detached: false,
		windowsHide: true,
		shell: false,
	});
}

function getExtensionDir(): string {
	// When loaded from dist/, listener/ is a sibling of dist/ â†’ go up one level.
	// When loaded directly (e.g. ~/.pi/agent/extensions/speak.ts), listener/ is a
	// sibling of the .ts file â†’ import.meta.dirname is already correct.
	const candidate = join(import.meta.dirname, "..", "listener", "listener.py");
	if (existsSync(candidate)) return join(import.meta.dirname, "..");
	return import.meta.dirname;
}

function getPython(): string {
	return getPythonCommand(process.env);
}

function getListenerPythonEnv(): NodeJS.ProcessEnv {
	// Preserve the Windows user-profile variables Python uses to locate
	// user-site packages such as %APPDATA%\\Python\\Python314\\site-packages.
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH || "",
		PYTHONPATH: process.env.PYTHONPATH || "",
		APPDATA: process.env.APPDATA || "",
		LOCALAPPDATA: process.env.LOCALAPPDATA || "",
		USERPROFILE: process.env.USERPROFILE || "",
		HOME: process.env.HOME || process.env.USERPROFILE || "",
		SYSTEMROOT: process.env.SYSTEMROOT || "",
		SYSTEMDRIVE: process.env.SYSTEMDRIVE || "",
		TEMP: process.env.TEMP || "",
		TMP: process.env.TMP || "",
		PI_SPEAK_WAKE_PHRASE:
			(process.env.PI_SPEAK_WAKE_PHRASE || process.env.PI_SPEAK_MONO_WAKE_PHRASE || MONO_WAKE_PHRASE).trim(),
	};

	const optionalEnv = {
		VOSK_MODEL_PATH: process.env.VOSK_MODEL_PATH,
		WHISPER_DEVICE: process.env.WHISPER_DEVICE,
		WHISPER_COMPUTE: process.env.WHISPER_COMPUTE,
		WHISPER_MODEL: process.env.WHISPER_MODEL,
		PI_SPEAK_MONO_ACTIVITY_TIMEOUT:
			process.env.PI_SPEAK_MONO_ACTIVITY_TIMEOUT || process.env.MONO_ACTIVITY_TIMEOUT,
	};

	for (const [key, value] of Object.entries(optionalEnv)) {
		const trimmed = value?.trim();
		if (trimmed) env[key] = trimmed;
	}

	return env;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function resolveOhMyPiCommand() {
	return process.env.PI_SPEAK_OH_MY_PK_BIN?.trim()
		|| process.env.OMPK_BIN?.trim()
		|| process.env.PI_SPEAK_OH_MY_PI_BIN?.trim()
		|| process.env.OMP_BIN?.trim()
		|| resolveWindowsNpmShim("ompk.cmd")
		|| resolveWindowsNpmShim("ompk")
		|| resolveWindowsNpmShim("omp.cmd")
		|| resolveWindowsNpmShim("omp")
		|| "ompk";
}

function launchOhMyPiResume(sessionArg: string, cwd: string) {
	const command = resolveOhMyPiCommand();
	const child = spawnDetached(command, ["--resume", sessionArg], cwd);
	child.unref();
	return command;
}

function launchOhMyPiAgent(argv: string[], cwd: string) {
	const command = resolveOhMyPiCommand();
	const child = spawnDetached(command, argv, cwd);
	child.unref();
	return { command, argv, cwd };
}

function launchColabDeployment(cwd: string) {
	const plan = buildColabLaunchPlan({ cwd }, cwd);
	if (!plan.ok) return plan;
	const child = spawnDetached(plan.command, plan.argv, plan.cwd);
	child.unref();
	return plan;
}

function launchSessionTarget(payload: SessionLaunchPayload, source: SessionEventSource = "admin"): ControlActionResult {
	const fallbackCwd = payload.cwd?.trim()
		|| DEFAULT_AGENT_CWD
		|| process.cwd();
	const built = buildOhMyPiLaunchArgv({
		cwd: payload.cwd,
		prompt: payload.prompt,
		model: payload.model,
		provider: payload.provider,
		sessionDir: payload.sessionDir,
		hubOnly: payload.hubOnly,
		targetNode: payload.targetNode,
	}, fallbackCwd);
	if (!built.ok) {
		return { ok: false, message: built.message };
	}
	try {
		if (built.targetNode === "colab") {
			const launched = launchColabDeployment(built.cwd);
			if (!launched.ok) return { ok: false, message: launched.message };
			appendSessionEvent("sess.launch", source, {
				provider: "colab",
				targetNode: "colab",
				mode: "colab",
				runId: launched.runId,
				session: launched.session,
				target: launched.target,
				argv: launched.argv,
				cwd: launched.cwd,
				command: launched.command,
			});
			return {
				ok: true,
				message: `Launching Colab deployment ${launched.runId} for ${launched.cwd}.`,
				command: launched.command,
				commandPreview: launched.commandPreview,
				argv: launched.argv,
				cwd: launched.cwd,
				runId: launched.runId,
				session: launched.session,
				target: launched.target,
				targetNode: "colab",
			};
		}
		const launched = launchOhMyPiAgent(built.argv, built.cwd);
		appendSessionEvent("sess.launch", source, {
			provider: "oh-my-pk",
			mode: built.mode,
			argv: launched.argv,
			cwd: launched.cwd,
			command: launched.command,
		});
		return {
			ok: true,
			message: built.mode === "hub"
				? `Launching Oh-my-pk Agent Hub in ${launched.cwd}.`
				: `Launching Oh-my-pk agent in ${launched.cwd}.`,
			command: launched.command,
			argv: launched.argv,
			cwd: launched.cwd,
		};
	} catch (error) {
		return { ok: false, message: `Session launch failed: ${getErrorMessage(error)}` };
	}
}

function getTelegramBotToken(state?: PhoneBridgeState) {
	return process.env.PI_SPEAK_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || state?.botToken?.trim() || "";
}

function maskToken(value: string) {
	const trimmed = value.trim();
	if (trimmed.length <= 8) return "[set]";
	return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function isListenerEvent(value: unknown): value is ListenerEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	if (typeof event.type !== "string") return false;
	switch (event.type) {
		case "wake":
			return typeof event.state === "string";
		case "speech":
			return typeof event.text === "string";
		case "transcribing":
			return true;
		case "status":
		case "error":
			return typeof event.message === "string";
		default:
			return false;
	}
}


function getOmpAgentConfigPath(): string | undefined {
	const home = process.env.USERPROFILE || process.env.HOME;
	if (!home) return undefined;
	return join(home, ".omp", "agent", "config.yml");
}

function disableOmpSpeechConfig(): void {
	const configPath = getOmpAgentConfigPath();
	if (configPath && existsSync(configPath)) {
		try {
			const raw = readFileSync(configPath, "utf8");
			const next = raw.replace(/(^speech:\s*\n\s*enabled:\s*)true\b/m, "$1false");
			if (next !== raw) writeFileSync(configPath, next, "utf8");
		} catch {}
	}
	// Keep omp + pi-speak sentinels in lockstep with hard-stop.
	enableRootVoiceDisable();
}

function enableOmpSpeechConfig(): void {
	const configPath = getOmpAgentConfigPath();
	if (configPath && existsSync(configPath)) {
		try {
			const raw = readFileSync(configPath, "utf8");
			const next = raw.replace(/(^speech:\s*\n\s*enabled:\s*)false\b/m, "$1true");
			if (next !== raw) writeFileSync(configPath, next, "utf8");
		} catch {}
	}
	clearRootVoiceDisable();
}

export default function speakExtension(pi: ExtensionAPI) {
	let speakState: SpeakState = {
		enabled: false,
		provider: "auto",
	};
	let lastAssistantText = "";
	let speakingProcess: ChildProcess | undefined;
	let playerProcess: ChildProcess | undefined;
	let speakAbortController: AbortController | undefined;
	let activeAudioDir: string | undefined;
	let phase: "ready" | "llm" | "rewrite" | "voice" | "playing" = "ready";
	let lastCtx: any;
	let listenerProcess: ChildProcess | undefined;
	let listenerRl: ReturnType<typeof createInterface> | undefined;
	let monoActive = false;
	let voiceInputActive = false;
	let voiceTarget: string | undefined;
	let sessionRegistry: Record<string, string> = {};
	let sessionWakeAliases: Record<string, string> = {};
	let pendingSessionRemoval:
		| { sessionPath: string; sessionName: string; requestedAt: number }
		| undefined;
	const approvalRegistry = createApprovalRegistry();
	let pendingSessSource: SessionEventSource | undefined;
	let lastRoutingStoreMtime = 0;
	let routingStoreWatcherPath: string | undefined;
	let phoneBridge: TelegramPhoneBridge | undefined;
	let phoneState: PhoneBridgeState = { enabled: false };
	let remoteServer: ControlServer | undefined;
	let remoteTray: RemoteTrayRuntime | undefined;
	let remoteState: RemoteState = {
		enabled: false,
		host: DEFAULT_REMOTE_HOST,
		port: DEFAULT_REMOTE_PORT,
		authToken: process.env.PI_SPEAK_HTTP_TOKEN || DEFAULT_REMOTE_AUTH_TOKEN,
	};
	let remoteDefaultTarget = remoteState.defaultTarget;
	let pendingRemoteTurn: PendingRemoteTurn | undefined;
	const remoteTurnManager = new RemoteTurnManager({
		onStateChange: () => updateRemoteStatus(),
	});
	const agentProviderConfig = resolveAgentProviderConfig(process.env);
	const piAgentProvider = new PiAgentProvider({
		sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
	});
	const ompAgentProvider = createOmpAgentProvider(resolveOhMyPiCommand(), DEFAULT_AGENT_CWD || process.cwd(), process.env);
	const ompSelection = new OmpSelectionStore();
	const getActiveOmpProvider = (clientKey?: string) => {
		const selected = ompSelection.get(clientKey);
		return selected
			? createOmpResumeProvider(resolveOhMyPiCommand(), DEFAULT_AGENT_CWD || process.cwd(), selected, process.env)
			: ompAgentProvider;
	};
	const codexAgentProvider = new CodexAgentProvider({
		codexBin: agentProviderConfig.codexBin,
		model: agentProviderConfig.model,
		cwd: DEFAULT_AGENT_CWD || process.cwd(),
		approvalPolicy: agentProviderConfig.approvalPolicy,
		sandbox: agentProviderConfig.sandbox,
		onApprovalRequest: async (request) => {
			const description = describeCodexApprovalForVoice(request);
			if (!listenerProcess) {
				notifyAudible(
					lastCtx,
					`Codex requested approval but voice listener is off: ${description}. Auto-declining.`,
					"warning",
				);
				return "decline";
			}
			notifyAudible(lastCtx, `Codex approval: ${description}`, "warning", `Approve ${description}. Say yes or no.`);
			return await approvalRegistry.request({
				description,
				spokenPrompt: `Approve ${description}. Say yes or no.`,
				timeoutMs: 30_000,
			});
		},
	});
	const claudeAgentProvider = new ClaudeAgentProvider({
		claudeBin: process.env.CLAUDE_BIN?.trim() || resolveWindowsNpmShim("claude.cmd") || agentProviderConfig.claudeBin,
		model: agentProviderConfig.model,
		cwd: DEFAULT_AGENT_CWD || process.cwd(),
		env: process.env,
	});
	const getAgentProvider = (): AgentProvider =>
		agentProviderConfig.provider === "codex"
			? codexAgentProvider
			: agentProviderConfig.provider === "claude"
				? claudeAgentProvider
				: agentProviderConfig.provider === "oh-my-pk"
					? ompAgentProvider
					: piAgentProvider;
	let forceSpeechPromptNextTurn = false;
	const diagnostics: RuntimeDiagnostics = {
		lastErrors: {},
		recentTimings: {},
		listener: {},
	};

	const getSpeakRuntimeState = (): SpeakRuntimeState => ({
		provider: speakState.provider,
		rewriteEnabled: speakState.rewriteEnabled,
	});

	const updateStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		lastCtx = target;
		if (!speakState.enabled) {
			target.ui.setStatus("speak", "");
			return;
		}
		const provider = resolveTtsProvider(getSpeakRuntimeState());
		const labels: Record<typeof phase, string> = {
			ready: "ready",
			llm: "llm",
			rewrite: "rewrite",
			voice: provider,
			playing: "playing",
		};
		target.ui.setStatus("speak", `speak:${provider} · ${labels[phase]}`);
	};

	const updateMonoStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		if (!monoActive) {
			target.ui.setStatus("mono", "");
			return;
		}
		const label = voiceInputActive
			? voiceTarget
				? `mono:listening -> ${voiceTarget}`
				: "mono:listening"
			: "mono:standby";
		target.ui.setStatus("mono", label);
	};

	const updatePhoneStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		if (!phoneState.enabled) {
			target.ui.setStatus("phone", "");
			return;
		}
		const linked = phoneState.linkedChatId ? "linked" : `pair ${phoneState.linkCode || "pending"}`;
		target.ui.setStatus("phone", `phone:${linked}`);
	};

	const updateRemoteStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		if (!remoteState.enabled) {
			target.ui.setStatus("remote", "");
			return;
		}
		const queue = remoteTurnManager.getSnapshot();
		const suffix = queue.processing ? ` busy+${queue.queued}` : queue.queued > 0 ? ` q${queue.queued}` : "";
		target.ui.setStatus("remote", `remote:${remoteState.port || DEFAULT_REMOTE_PORT}${suffix}`);
	};

	const setPhase = (next: typeof phase, ctx?: any) => {
		phase = next;
		updateStatus(ctx);
	};

	const persistState = () => {
		pi.appendEntry<SpeakState>(STATE_TYPE, { ...speakState });
	};

	const persistMonoState = () => {
		pi.appendEntry<MonoState>(MONO_STATE_TYPE, { listening: monoActive });
	};

	const persistPhoneState = () => {
		pi.appendEntry<PhoneBridgeState>(PHONE_STATE_TYPE, { ...phoneState });
	};

	const persistRemoteState = () => {
		pi.appendEntry<RemoteState>(REMOTE_STATE_TYPE, { ...remoteState });
	};

	const readRoutingStoreMtime = () => {
		try {
			return statSync(getSessionRoutingStorePath()).mtimeMs;
		} catch {
			return 0;
		}
	};

	const persistSessionRoutingState = () => {
		persistSessionRouting({ sessions: sessionRegistry, aliases: sessionWakeAliases });
		lastRoutingStoreMtime = readRoutingStoreMtime();
	};

	const broadcastSessionRoutingState = () => {
		pi.appendEntry<SessionRegistryState>(SESSION_REGISTRY_TYPE, { sessions: sessionRegistry });
		pi.appendEntry<SessionWakeAliasState>(SESSION_WAKE_ALIAS_TYPE, { aliases: sessionWakeAliases });
	};

	const syncCurrentSessionNameFromRoutingStore = (ctx?: any) => {
		const target = ctx || lastCtx;
		const currentSessionPath = target?.sessionManager?.getSessionFile?.();
		if (!currentSessionPath) return;
		const routedName = findSessionNameByPath(currentSessionPath, sessionRegistry);
		const currentName = pi.getSessionName() || "";
		if (routedName && routedName !== currentName) {
			pi.setSessionName(routedName);
			return;
		}
		if (!routedName && currentName) {
			pi.setSessionName("");
		}
	};

	const reloadSessionRoutingIfExternallyChanged = (ctx?: any) => {
		const mtime = readRoutingStoreMtime();
		if (!mtime || mtime === lastRoutingStoreMtime) return false;
		const persisted = loadPersistedSessionRouting();
		sessionRegistry = { ...persisted.sessions };
		sessionWakeAliases = { ...persisted.aliases };
		lastRoutingStoreMtime = mtime;
		syncCurrentSessionNameFromRoutingStore(ctx);
		broadcastSessionRoutingState();
		return true;
	};

	const startRoutingStoreWatcher = () => {
		if (routingStoreWatcherPath) return;
		const storePath = getSessionRoutingStorePath();
		try {
			watchFile(storePath, { interval: 500 }, () => {
				reloadSessionRoutingIfExternallyChanged();
			});
			routingStoreWatcherPath = storePath;
		} catch {
			routingStoreWatcherPath = undefined;
		}
	};

	const stopRoutingStoreWatcher = () => {
		if (!routingStoreWatcherPath) return;
		try {
			unwatchFile(routingStoreWatcherPath);
		} catch {}
		routingStoreWatcherPath = undefined;
	};

	const persistSessionRegistry = () => {
		persistSessionRoutingState();
		pi.appendEntry<SessionRegistryState>(SESSION_REGISTRY_TYPE, { sessions: sessionRegistry });
	};

	const persistSessionWakeAliases = () => {
		persistSessionRoutingState();
		pi.appendEntry<SessionWakeAliasState>(SESSION_WAKE_ALIAS_TYPE, { aliases: sessionWakeAliases });
	};

	const getKnownTargets = () => listKnownTargets(sessionRegistry, sessionWakeAliases);
	const getKnownTargetsText = () => getKnownTargets().join(", ") || "none";
	const findSessionNameByPathLocal = (sessionPath: string) => findSessionNameByPath(sessionPath, sessionRegistry);
	const findSessionByTarget = (target: string) => resolveSessionTarget(target, sessionRegistry, sessionWakeAliases);
	const getSessionManagerSummaryText = (ctx?: any) => formatSessionManagerSummary({
		sessions: sessionRegistry,
		aliases: sessionWakeAliases,
		currentSessionPath: ctx?.sessionManager?.getSessionFile?.(),
		currentSessionName: pi.getSessionName() || undefined,
		currentBusy: false,
		currentReady: false,
		storePath: getSessionRoutingStorePath(),
	});
	const getAliasesForSession = (sessionPath: string) => Object.entries(sessionWakeAliases)
		.filter(([, path]) => path === sessionPath)
		.map(([alias]) => alias)
		.sort((a, b) => a.localeCompare(b));
	const getSessionEditGuideText = (sessionPath: string, label: string, ctx?: any) => {
		const displayName = findSessionNameByPathLocal(sessionPath) || (ctx?.sessionManager?.getSessionFile?.() === sessionPath ? pi.getSessionName() : undefined) || label;
		const aliases = getAliasesForSession(sessionPath);
		return [
			`Session: ${displayName}`,
			`Aliases: ${aliases.length > 0 ? aliases.join(", ") : "none"}`,
			"Shortcuts",
			`- /sess switch ${displayName}`,
			`- /sess rename ${displayName} <new-name>`,
			`- /sess alias add ${displayName} <alias>`,
			...(aliases.map((alias) => `- /sess alias remove ${alias}`)),
			`- /sess remove ${displayName}`,
		].join("\n");
	};
	const getSessCompletions = (prefix: string) => {
		const trimmed = prefix.trimStart();
		const complete = (value: string, label = value) => ({ value, label });
		const top = ["new", "switch", "rename", "edit", "remove", "confirm", "alias", "launch", "list", "name", "wake", "slots", "ui", "export"];
		if (!trimmed) return top.map((value) => complete(value));
		const firstSpace = trimmed.indexOf(" ");
		if (firstSpace === -1) return top.filter((value) => value.startsWith(trimmed.toLowerCase())).map((value) => complete(value));
		const sub = trimmed.slice(0, firstSpace).toLowerCase();
		const rest = trimmed.slice(firstSpace + 1);
		const targets = getKnownTargets();
		const aliases = Object.keys(sessionWakeAliases).sort((a, b) => a.localeCompare(b));
		if (["switch", "remove"].includes(sub)) {
			const targetPrefix = rest.trim().toLowerCase();
			return targets
				.filter((value) => value.toLowerCase().startsWith(targetPrefix))
				.map((value) => complete(`${sub} ${value}`, `${sub} ${value}`));
		}
		if (sub === "rename") {
			if (!rest.includes(" ")) return targets.filter((value) => value.toLowerCase().startsWith(rest.toLowerCase())).map((value) => complete(`rename ${value}`, `rename ${value}`));
			return null;
		}
		if (sub === "confirm") {
			if ("remove".startsWith(rest.toLowerCase())) return [complete("confirm remove")];
			if (rest.toLowerCase().startsWith("remove ")) {
				const targetPrefix = rest.slice("remove ".length);
				return targets.filter((value) => value.toLowerCase().startsWith(targetPrefix.toLowerCase())).map((value) => complete(`confirm remove ${value}`, `confirm remove ${value}`));
			}
		}
		if (sub === "launch") {
			const launchOptions = ["colab", "hub"];
			const launchPrefix = rest.trim().toLowerCase();
			return launchOptions
				.filter((value) => value.startsWith(launchPrefix))
				.map((value) => complete(`launch ${value}`, `launch ${value}`));
		}
		if (sub === "alias") {
			const aliasSub = rest.trimStart();
			if (!aliasSub) return [complete("alias add"), complete("alias remove"), complete("alias list")];
			if (aliasSub.startsWith("remove")) {
				const aliasPrefix = aliasSub.replace(/^remove\s*/, "");
				return aliases.filter((value) => value.toLowerCase().startsWith(aliasPrefix.toLowerCase())).map((value) => complete(`alias remove ${value}`, `alias remove ${value}`));
			}
		}
		if (sub === "edit") {
			const parts = rest.split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				return targets.map((value) => complete(`edit ${value}`, `edit ${value}`));
			}
			if (parts.length === 1) {
				const target = parts[0];
				return [
					complete(`edit ${target}`, `edit ${target}`),
					complete(`edit ${target} rename`, `edit ${target} rename`),
					complete(`edit ${target} alias remove`, `edit ${target} alias remove`),
				];
			}
			if (parts.length >= 2 && parts[1] === "alias" && parts[2] === "remove") {
				return aliases.map((value) => complete(`edit ${parts[0]} alias remove ${value}`, `edit ${parts[0]} alias remove ${value}`));
			}
		}
		return null;
	};

	const syncPhoneState = (patch: Partial<PhoneBridgeState>, persist = false) => {
		phoneState = { ...phoneState, ...patch };
		if (persist) persistPhoneState();
		updatePhoneStatus();
	};

	const syncRemoteState = (patch: Partial<RemoteState>, persist = false) => {
		remoteState = { ...remoteState, ...patch };
		remoteState.authToken = process.env.PI_SPEAK_HTTP_TOKEN || DEFAULT_REMOTE_AUTH_TOKEN;
		remoteDefaultTarget = remoteState.defaultTarget;
		if (persist) persistRemoteState();
		updateRemoteStatus();
	};

	const getRoutingStatus = () => ({
		defaultTarget: remoteDefaultTarget,
		currentSession: pi.getSessionName() || undefined,
		availableTargets: [...getKnownTargets(), ...(remoteDefaultTarget?.startsWith("herdr:") ? [remoteDefaultTarget] : [])],
	});

	const setRoutingTarget = (target?: string): ControlActionResult => {
		const trimmed = target?.trim();
		if (!trimmed) {
			syncRemoteState({ defaultTarget: undefined }, true);
			return { ok: true, message: "Remote target cleared. New turns stay on the current session." };
		}
		if (trimmed.startsWith("herdr:")) {
			syncRemoteState({ defaultTarget: trimmed }, true);
			return { ok: true, message: `Remote target set to ${trimmed}.` };
		}
		const match = resolveSessionByName(trimmed);
		if (!match) {
			const available = Object.keys(sessionRegistry).sort((a, b) => a.localeCompare(b)).join(", ") || "none";
			return { ok: false, message: `Unknown target "${trimmed}". Known: ${available}` };
		}
		syncRemoteState({ defaultTarget: match.sessionName }, true);
		return { ok: true, message: `Remote target set to ${match.sessionName}.` };
	};

	const cleanupAudioFiles = () => {
		if (activeAudioDir && existsSync(activeAudioDir)) {
			try {
				rmSync(activeAudioDir, { recursive: true, force: true });
			} catch {}
		}
		activeAudioDir = undefined;
	};

	const stopSpeaking = (ctx?: any) => {
		speakAbortController?.abort();
		speakAbortController = undefined;
		if (speakingProcess && !speakingProcess.killed) {
			try {
				speakingProcess.kill();
			} catch {}
		}
		if (playerProcess && !playerProcess.killed) {
			try {
				playerProcess.kill();
			} catch {}
		}
		speakingProcess = undefined;
		playerProcess = undefined;
		cleanupAudioFiles();
		setPhase("ready", ctx);
	};

	const playAudioFile = (filePath: string, ctx?: any, audioDir?: string) => {
		setPhase("playing", ctx);
		const player = getPlayerInvocation(filePath);
		const playbackDir = audioDir;
		playerProcess = spawn(player.command, player.args, {
			stdio: "ignore",
			detached: false,
			windowsHide: true,
			shell: false,
		});
		playerProcess.on("exit", () => {
			playerProcess = undefined;
			if (playbackDir && activeAudioDir === playbackDir) cleanupAudioFiles();
			setPhase("ready", ctx);
		});
		playerProcess.on("error", () => {
			playerProcess = undefined;
			if (playbackDir && activeAudioDir === playbackDir) cleanupAudioFiles();
			setPhase("ready", ctx);
		});
	};

	const speakText = async (text: string, ctx?: any) => {
		const trimmed = text.trim();
		if (!speakState.enabled || !trimmed) return;
		if (isRootVoiceDisabled()) return;

		stopSpeaking(ctx);

		const audioDir = mkdtempSync(join(tmpdir(), "pi-speak-"));
		const outputPath = join(audioDir, "reply.mp3");
		activeAudioDir = audioDir;

		const abortController = new AbortController();
		speakAbortController = abortController;

		try {
			await synthesizeToFile({
				text: trimmed,
				outputPath,
				state: getSpeakRuntimeState(),
				signal: abortController.signal,
				onPhase: (nextPhase) => setPhase(nextPhase, ctx),
				onLegacyProcess: (process) => {
					speakingProcess = process;
				},
			});
			speakingProcess = undefined;
			if (abortController.signal.aborted) return;
			if (!speakState.enabled || isRootVoiceDisabled()) {
				cleanupAudioFiles();
				setPhase("ready", ctx);
				return;
			}
			if (!existsSync(outputPath)) {
				throw new Error("Speech synthesis did not create an audio file");
			}
			playAudioFile(outputPath, ctx, audioDir);
		} catch (error) {
			speakingProcess = undefined;
			if (abortController.signal.aborted) return;
			cleanupAudioFiles();
			setPhase("ready", ctx);
			const target = ctx || lastCtx;
			target?.ui?.notify?.(`Speech synthesis failed: ${getErrorMessage(error)}`, "error");
		} finally {
			if (speakAbortController === abortController) {
				speakAbortController = undefined;
			}
		}
	};

	// Notify + optional TTS in one call. By default warnings and errors are
	// spoken so a headphones-only operator hears them; info messages stay
	// silent unless the caller passes an explicit spoken override (avoids
	// drowning the user in routine chatter). speakText itself no-ops when
	// speakState is disabled, so this is safe to call unconditionally.
	const notifyAudible = (
		ctx: any,
		message: string,
		severity: "info" | "warning" | "error" = "info",
		spoken?: string,
	) => {
		ctx?.ui?.notify?.(message, severity);
		if (severity === "info" && !spoken) return;
		void speakText(spoken ?? message, ctx);
	};

	const renderRemoteAudio = async (text: string, ctx?: any) => {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const audioDir = mkdtempSync(join(tmpdir(), "pi-phone-reply-"));
		const outputPath = join(audioDir, "reply.mp3");
		const startedAt = Date.now();
		try {
			const synthesis = await synthesizeToFile({
				text: trimmed,
				outputPath,
				state: getSpeakRuntimeState(),
			});
			const ttsMs = Date.now() - startedAt;
			return {
				audioPath: outputPath,
				audioMimeType: getAudioMimeType(outputPath),
				timings: { ttsMs },
				providers: { tts: synthesis.provider },
			};
		} catch (error) {
			const primaryError = getErrorMessage(error);
			try {
				rmSync(audioDir, { recursive: true, force: true });
			} catch {}
			let warnings = [`Audio synthesis failed: ${primaryError}`];
			const primaryTtsMs = Date.now() - startedAt;
			diagnostics.lastErrors.tts = primaryError;
			const target = ctx || lastCtx;
			target?.ui?.notify?.(`Phone audio synthesis failed: ${primaryError}`, "warning");
			if (!isGeminiLiveConfigured()) {
				return {
					warnings,
					timings: { ttsMs: primaryTtsMs },
				};
			}

			const geminiStartedAt = Date.now();
			try {
				const geminiResult = await runGeminiLiveTurn(trimmed, {
					timeoutMs: Number.parseInt(process.env.PI_SPEAK_GEMINI_LIVE_TIMEOUT_MS || "45000", 10),
				});
				return {
					audioPath: geminiResult.audioPath,
					audioMimeType: geminiResult.audioMimeType,
					timings: { ttsMs: primaryTtsMs + (Date.now() - geminiStartedAt) },
					providers: {
						tts: geminiResult.providers?.tts || "gemini-live",
						agent: geminiResult.providers?.agent || undefined,
					},
					warnings: [...warnings, ...(geminiResult.warnings || []), "Fallback used: Gemini Live."],
				};
			} catch (geminiError) {
				return {
					warnings: [...warnings, `Gemini Live fallback failed: ${getErrorMessage(geminiError)}`],
					timings: { ttsMs: Date.now() - startedAt },
				};
			}
		}
	};

	const resolveSessionByName = (name: string) => {
		const targetMatch = findSessionByTarget(name);
		if (targetMatch) {
			return { sessionName: findSessionNameByPathLocal(targetMatch.sessionPath) || targetMatch.matchedLabel, sessionPath: targetMatch.sessionPath, matchedBy: "exact" as const };
		}
		return resolveSessionRoute(name, sessionRegistry);
	};

	const findSessionByName = (name: string): string | undefined => resolveSessionByName(name)?.sessionPath;

	const getSessionRouteConflictText = (name: string, ctx?: any) => {
		const sessionFile = ctx?.sessionManager?.getSessionFile?.();
		const conflict = findSessionRouteConflict(name, sessionRegistry, sessionFile);
		if (!conflict) return undefined;
		if (conflict.reason === "numeric-family") {
			const familyLabel = conflict.family === "1" ? '"one" / "1"' : '"two" / "2"';
			return `Session name "${name}" conflicts with existing route "${conflict.sessionName}". Keep the ${familyLabel} voice family mapped to only one session so PK ${conflict.family}, PK ${conflict.family === "1" ? "one" : "two"}, and fused forms stay distinct.`;
		}
		return `Session name "${name}" already points to another session. Choose a different name.`;
	};

	const getWakeAliasConflictText = (alias: string, sessionPath: string) => {
		const conflict = findSessionRouteConflict(alias, sessionWakeAliases, sessionPath);
		if (!conflict) return undefined;
		if (conflict.reason === "numeric-family") {
			const familyLabel = conflict.family === "1" ? '"one" / "1"' : '"two" / "2"';
			return `Wake alias "${alias}" conflicts with existing alias "${conflict.sessionName}". Keep the ${familyLabel} voice family mapped to only one session so PK ${conflict.family}, PK ${conflict.family === "1" ? "one" : "two"}, and fused forms stay distinct.`;
		}
		return `Wake alias "${alias}" already points to another session. Choose a different alias.`;
	};

	const persistAllSessionRoutingState = () => {
		persistSessionRoutingState();
		pi.appendEntry<SessionRegistryState>(SESSION_REGISTRY_TYPE, { sessions: sessionRegistry });
		pi.appendEntry<SessionWakeAliasState>(SESSION_WAKE_ALIAS_TYPE, { aliases: sessionWakeAliases });
	};

	const waitForReadyTurnContext = async () => {
		const startedAt = Date.now();
		const deadline = Date.now() + PHONE_TURN_WAIT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const ctx = lastCtx;
			if (ctx) {
				const idle = ctx.isIdle?.() ?? true;
				const hasPendingMessages = ctx.hasPendingMessages?.() ?? false;
				if (idle && !hasPendingMessages && !pendingRemoteTurn) {
					return {
						ctx,
						waitMs: Date.now() - startedAt,
					};
				}
			}
			await sleep(250);
		}
		throw new Error("Timed out waiting for Pi to become ready for a phone turn");
	};

	const clearPendingRemoteTurnTimeout = (pending?: PendingRemoteTurn) => {
		if (!pending?.timeoutId) return;
		clearTimeout(pending.timeoutId);
		pending.timeoutId = undefined;
	};

	const rejectPendingPhoneTurn = (reason: string) => {
		if (!pendingRemoteTurn) return;
		const pending = pendingRemoteTurn;
		pendingRemoteTurn = undefined;
		clearPendingRemoteTurnTimeout(pending);
		diagnostics.lastErrors.remote = reason;
		pending.reject(new Error(reason));
	};

	const resolvePendingPhoneTurn = async (ctx?: any) => {
		if (!pendingRemoteTurn) return;
		const pending = pendingRemoteTurn;
		pendingRemoteTurn = undefined;
		clearPendingRemoteTurnTimeout(pending);
		diagnostics.lastErrors.remote = undefined;
		const replyText = lastAssistantText.trim() || "I finished the turn, but no assistant text was captured.";
		const audioResult = pending.wantAudio ? await renderRemoteAudio(replyText, ctx) : undefined;
		const mergedTimings = {
			...pending.timings,
			...audioResult?.timings,
		};
		diagnostics.recentTimings.lastRemoteTurn = mergedTimings;
		pending.resolve({
			replyText,
			audioPath: audioResult?.audioPath,
			audioMimeType: audioResult?.audioMimeType,
			transcript: pending.transcript,
			timings: mergedTimings,
			providers: {
				...pending.providers,
				...audioResult?.providers,
			},
			warnings: [...(pending.warnings || []), ...(audioResult?.warnings || [])],
		});
	};

	const runAgentPrompt = async (
		prompt: string,
		options: { mode?: "turn" | "steer" | "followUp"; timeoutMs?: number; cwd?: string; model?: string } = {},
		agentProviderOverride?: AgentProvider,
	) => {
		const provider = agentProviderOverride || getAgentProvider();
		if (provider.name === "pi") {
			forceSpeechPromptNextTurn = true;
		}
		const replyText = await collectAgentResponse(provider, prompt, {
			mode: options.mode,
			model: options.model || agentProviderConfig.model,
			cwd: options.cwd || DEFAULT_AGENT_CWD || undefined,
			timeoutMs: options.timeoutMs ?? PHONE_TURN_WAIT_TIMEOUT_MS,
			instructions: SPEECH_MODE_PROMPT,
		});
		return replyText || "I finished the turn, but no assistant text was captured.";
	};

	const executePhoneTurn = async (
		source: "http-text" | "http-voice" | "telegram-text" | "telegram-voice",
		text: string,
		transcript?: string,
		wantAudio = true,
		timings?: TurnTimingSummary,
		providers?: { stt?: string; tts?: string },
		warnings?: string[],
		targetName?: string,
		cwd?: string,
		mode: "auto" | "live" = "auto",
		agentProvider?: GatewayAgentProvider,
		model?: string,
	): Promise<RemoteTurnResult> => {
		const trimmed = text.trim();
		if (!trimmed) {
			const replyText = "I did not receive any text to send to Pi.";
			appendExecutionTrace({
				ts: Date.now(),
				source,
				rawText: trimmed,
				targetName: targetName?.trim() || remoteDefaultTarget,
				outcome: "no-input",
				replyText,
			});
			return { replyText, transcript };
		}

		const desiredTarget = targetName?.trim() || remoteDefaultTarget;
		if (desiredTarget?.startsWith("herdr:")) {
			const paneId = desiredTarget.slice("herdr:".length).trim();
			const result = await sendHerdrPane({ paneId, text: trimmed, submit: true });
			const replyText = result.ok ? `Sent turn to Herdr pane ${paneId}.` : `Herdr turn failed: ${result.message}`;
			appendExecutionTrace({
				ts: Date.now(),
				source,
				rawText: trimmed,
				targetName: desiredTarget,
				outcome: result.ok ? "dispatch-success" : "dispatch-failed",
				replyText,
			});
			return { replyText, transcript, warnings: result.ok ? warnings : [...(warnings || []), result.message] };
		}
		const isVoiceInput = source === "http-voice" || source === "telegram-voice";
		const directBackend: GatewayAgentProvider = agentProvider || (
			agentProviderConfig.provider === "codex" || agentProviderConfig.provider === "claude" || agentProviderConfig.provider === "oh-my-pk"
				? agentProviderConfig.provider
				: "pi"
		);
		const localSlashResult = handleGatewaySlashCommand(trimmed, {
			model,
			defaultModel: agentProviderConfig.model,
			cwd: cwd || DEFAULT_AGENT_CWD || undefined,
			agentProvider: directBackend,
		});
		if (localSlashResult) return { ...localSlashResult, transcript };
		const directSummary: ConversationReducerSummary = {
			goal: trimmed,
			actionItems: [trimmed],
			constraints: [],
			deferredReminders: [],
			doNotDo: [],
			unknowns: [],
			discarded: [],
			confidence: 1,
			shouldDispatch: true,
			clarifyingQuestion: undefined,
			engine: "heuristic",
		};
		const directExecutionPlan: ConversationExecutionPlan = {
			dispatch: true,
			backend: directBackend,
			reason: directBackend === "codex"
				? "dispatch-codex"
				: directBackend === "claude"
					? "dispatch-claude"
					: directBackend === "oh-my-pk"
						? "dispatch-oh-my-pk"
						: "dispatch-pi",
			confidence: 1,
			rationale: `Direct text turn to ${directBackend === "codex" ? "Codex" : directBackend === "claude" ? "Claude" : directBackend === "oh-my-pk" ? "Oh-my-pk" : "Pi"}; voice-only router bypassed.`,
			actionForSeed: trimmed,
		};
		const reducer = isVoiceInput
			? await reduceConversationTurn(trimmed, {
					source,
					targetName: desiredTarget,
					minConfidence: PI_SPEAK_REDUCER_MIN_CONFIDENCE,
				})
			: {
					summary: directSummary,
					promptForAgent: trimmed,
					replyText: "",
					dispatch: true,
					reducerMs: 0,
				};
		const reducerMs = reducer.reducerMs;
		const reducerTimings = {
			reducerMs,
		};
		const executionPlan = isVoiceInput
			? planConversationExecution(reducer.summary, {
					targetName: desiredTarget,
					provider: agentProvider,
				})
			: directExecutionPlan;
		const routeProgress: TurnProgressEvent[] = isVoiceInput ? [
			...(executionPlan.userProgress
				? [{
						ts: Date.now(),
						phase: "route" as const,
						message: executionPlan.userProgress,
						elapsedMs: reducerMs,
					}]
				: []),
			{
				ts: Date.now(),
				phase: "route",
				message: executionPlan.escalationReason
					? `Route: ${executionPlan.routeClass || "fast-plus-tools"} -> ${executionPlan.backend}. ${executionPlan.escalationReason}.`
					: `Route: ${executionPlan.routeClass || "fast-plus-tools"} -> ${executionPlan.backend}.`,
				elapsedMs: reducerMs,
			},
		] : [];
		const makeActionPlan = (decisions: ExecutionDecision[]): ExecutionPlanReplay => ({
			dispatch: executionPlan.dispatch,
			backend: executionPlan.backend,
			reason: executionPlan.reason,
			confidence: executionPlan.confidence,
			rationale: executionPlan.rationale,
			actionForSeed: executionPlan.actionForSeed,
			signals: executionPlan.signals,
			goal: reducer.summary.goal,
			actionItems: reducer.summary.actionItems,
			constraints: reducer.summary.constraints,
			deferredReminders: reducer.summary.deferredReminders,
			doNotDo: reducer.summary.doNotDo,
			unknowns: reducer.summary.unknowns,
			decisions,
		});

		if (!executionPlan.dispatch || !reducer.dispatch) {
			const completedTimings = {
				...reducerTimings,
				...timings,
				totalMs: (timings?.totalMs || 0) + reducerMs,
			};
			diagnostics.recentTimings.lastRemoteTurn = completedTimings;
			const replyText = executionPlan.dispatch
				? reducer.replyText
				: executionPlan.rationale || reducer.replyText || reducer.summary.clarifyingQuestion || "I need a clearer action before I dispatch this.";
			appendExecutionTrace({
				ts: Date.now(),
				source,
				rawText: trimmed,
				transcript,
				targetName: desiredTarget,
				reducerSummary: reducer.summary,
				executionPlan,
				actionPlan: makeActionPlan([
					{
						stage: "routing",
						outcome: "deferred",
						reason: executionPlan.rationale,
					},
				]),
				outcome: "skipped",
				timings: completedTimings,
				replyText,
				warnings: [...(warnings || []), replyText],
				providers: {
					...providers,
					agent: "reducer",
				},
			});
			return {
				replyText,
				transcript,
				execution: {
					...executionPlan,
					dispatch: executionPlan.dispatch,
					reason: executionPlan.reason,
				},
				timings: completedTimings,
				providers: {
					...providers,
					agent: "reducer",
				},
				reducer: reducer.summary,
				warnings: [...(warnings || []), executionPlan.rationale || reducer.summary.clarifyingQuestion || "I need a cleaner action before I dispatch this."],
				progress: routeProgress,
			};
		}

		const currentCtx = lastCtx;
		if (!currentCtx) {
			const reason = "No active Pi session is available for remote turns.";
			diagnostics.lastErrors.remote = reason;
			appendExecutionTrace({
				ts: Date.now(),
				source,
				rawText: trimmed,
				transcript,
				targetName: desiredTarget,
				reducerSummary: reducer.summary,
				executionPlan,
				actionPlan: makeActionPlan([
					{
						stage: "routing",
						outcome: "accepted",
						reason: executionPlan.rationale,
					},
					{
						stage: "dispatch",
						outcome: "blocked",
						reason,
					},
				]),
				outcome: "dispatch-blocked",
				warnings: [reason],
			});
			return {
				replyText: reason,
				transcript,
				reducer: reducer.summary,
				execution: executionPlan,
				warnings: [reason],
				progress: routeProgress,
			};
		}
		const currentSessionBusy = !(currentCtx.isIdle?.() ?? true) || (currentCtx.hasPendingMessages?.() ?? false);
		if (currentSessionBusy || pendingRemoteTurn) {
			const reason = desiredTarget
				? `Pi is busy. Finish the current turn before routing a remote turn to \"${desiredTarget}\".`
				: "Pi is busy in the current session. Finish the current turn, then try again.";
			diagnostics.lastErrors.remote = reason;
			appendExecutionTrace({
				ts: Date.now(),
				source,
				rawText: trimmed,
				transcript,
				targetName: desiredTarget,
				reducerSummary: reducer.summary,
				executionPlan,
				actionPlan: makeActionPlan([
					{
						stage: "routing",
						outcome: "accepted",
						reason: executionPlan.rationale,
					},
					{
						stage: "dispatch",
						outcome: "blocked",
						reason,
					},
				]),
				outcome: "dispatch-blocked",
				warnings: [reason],
			});
			throw new BusyError(reason);
		}

		let readiness = await waitForReadyTurnContext();
		if (desiredTarget && typeof readiness.ctx?.switchSession === "function") {
			const sessionPath = findSessionByName(desiredTarget);
			if (!sessionPath) {
				const available = Object.keys(sessionRegistry).sort((a, b) => a.localeCompare(b)).join(", ") || "none";
				const reason = `Unknown target "${desiredTarget}". Known: ${available}`;
				appendExecutionTrace({
					ts: Date.now(),
					source,
					rawText: trimmed,
					transcript,
					targetName: desiredTarget,
					reducerSummary: reducer.summary,
					executionPlan,
					actionPlan: makeActionPlan([
						{
							stage: "routing",
							outcome: "accepted",
							reason: executionPlan.rationale,
						},
						{
							stage: "dispatch",
							outcome: "blocked",
							reason,
						},
					]),
					outcome: "dispatch-blocked",
					warnings: [reason],
				});
				return { replyText: reason, transcript, execution: executionPlan, reducer: reducer.summary, warnings: [reason], progress: routeProgress };
			}
			const switched = await readiness.ctx.switchSession(sessionPath);
			if (switched?.cancelled) {
				const reason = `Switch to target "${desiredTarget}" was cancelled.`;
			appendExecutionTrace({
				ts: Date.now(),
				source,
				rawText: trimmed,
				transcript,
				targetName: desiredTarget,
				reducerSummary: reducer.summary,
				executionPlan,
				actionPlan: makeActionPlan([
					{
						stage: "routing",
						outcome: "accepted",
						reason: executionPlan.rationale,
					},
					{
						stage: "dispatch",
						outcome: "blocked",
						reason,
					},
				]),
				outcome: "dispatch-blocked",
				warnings: [reason],
			});
				return { replyText: `Switch to target "${desiredTarget}" was cancelled.`, transcript, execution: executionPlan, reducer: reducer.summary, warnings: [reason], progress: routeProgress };
			}
			readiness = await waitForReadyTurnContext();
		}
		const startedAt = Date.now();
		diagnostics.lastErrors.remote = undefined;

		let replyText = "";
		let executionProvider: AgentProvider;
		if (executionPlan.backend === "codex") {
			executionProvider = codexAgentProvider;
		} else if (executionPlan.backend === "claude") {
			executionProvider = claudeAgentProvider;
		} else if (executionPlan.backend === "pi") {
			executionProvider = piAgentProvider;
		} else if (executionPlan.backend === "oh-my-pk") {
			executionProvider = getActiveOmpProvider();
		} else {
			const reason = `Execution route \"${executionPlan.backend}\" is a placeholder and cannot run this turn yet.`;
			appendExecutionTrace({
				ts: Date.now(),
				source,
				rawText: trimmed,
				transcript,
				targetName: desiredTarget,
				reducerSummary: reducer.summary,
				executionPlan,
				actionPlan: makeActionPlan([
					{
						stage: "routing",
						outcome: "accepted",
						reason: executionPlan.rationale,
					},
					{
						stage: "dispatch",
						outcome: "blocked",
						reason,
					},
				]),
				outcome: "dispatch-blocked",
				warnings: [reason],
			});
			return {
				replyText: reason,
				transcript,
				reducer: reducer.summary,
				execution: executionPlan,
				warnings: [...(warnings || []), reason],
				progress: routeProgress,
			};
		}
		let usedLiveMode = false;
		let audioResult: Partial<RemoteTurnResult> | undefined;
		let agentRunMs = 0;
		let liveFailureWarnings: string[] = [];
		if (mode === "live" && wantAudio && isGeminiLiveConfigured()) {
			try {
				const liveStartedAt = Date.now();
				const liveResult = await runGeminiLiveTurn(reducer.promptForAgent, {
					model,
					timeoutMs: PHONE_TURN_WAIT_TIMEOUT_MS,
				});
				agentRunMs = Date.now() - liveStartedAt;
				replyText = liveResult.replyText;
				usedLiveMode = true;
				audioResult = {
					audioPath: liveResult.audioPath,
					audioMimeType: liveResult.audioMimeType,
					timings: {
						geminiLiveMs: agentRunMs,
					},
					providers: {
						agent: liveResult.providers?.agent || "gemini-live",
						...liveResult.providers,
					},
					warnings: [...(liveResult.warnings || [])],
				};
			} catch (error) {
				const fallbackWarning = `Gemini Live failed: ${getErrorMessage(error)}. Falling back to ${executionPlan.backend} execution.`;
				liveFailureWarnings = [fallbackWarning];
			}
		}

		let startedWithAgent = 0;
		if (!usedLiveMode) {
			try {
				startedWithAgent = Date.now();
				replyText = await runAgentPrompt(
					reducer.promptForAgent,
					{ timeoutMs: PHONE_TURN_WAIT_TIMEOUT_MS, cwd, model },
					executionProvider,
				);
				agentRunMs = Date.now() - startedWithAgent;
				audioResult = wantAudio ? await renderRemoteAudio(replyText, readiness.ctx) : undefined;
			} catch (error) {
				const reason = `Failed to run remote turn: ${getErrorMessage(error)}`;
				diagnostics.lastErrors.remote = reason;
			// H3 parity: only clear the selection when the failure is the resume
				// target itself being gone (stale/archived/removed) — re-validate with the
				// same shared validator. A transient failure (timeout, omp busy) leaves a
				// valid path, so we keep the selection instead of nuking it every blip.
				if (executionPlan.backend === "oh-my-pk") {
					const selected = ompSelection.get(undefined);
					if (selected) {
						const recheck = validateOmpSelection(selected);
						if (!recheck.ok) {
							ompSelection.select(undefined, null);
							appendSessionEvent("sess.omp-select-cleared", "admin", { reason, error: recheck.error });
							lastCtx?.ui?.notify?.(`Cleared the omp session selection: ${recheck.error}`, "warning");
						}
					}
				}
				const failedMs = Date.now() - (startedWithAgent || Date.now());
				agentRunMs = failedMs;
				appendExecutionTrace({
					ts: Date.now(),
					source,
					rawText: trimmed,
					transcript,
					targetName: desiredTarget,
					reducerSummary: reducer.summary,
					executionPlan,
					actionPlan: makeActionPlan([
						{
							stage: "routing",
							outcome: "accepted",
							reason: executionPlan.rationale,
						},
						{
							stage: "dispatch",
							outcome: "failed",
							reason,
						},
					]),
					outcome: "dispatch-failed",
					timings: {
						agentWaitMs: readiness.waitMs,
						agentRunMs: failedMs,
						reducerMs,
						totalMs: (timings?.totalMs || 0) + readiness.waitMs + failedMs,
					},
					replyText: reason,
					error: reason,
					warnings: [...(warnings || []), ...liveFailureWarnings, reason],
					providers: {
						...providers,
						agent: executionProvider.name,
					},
				});
				return {
					replyText: reason,
					transcript,
					timings: {
						agentWaitMs: readiness.waitMs,
						agentRunMs: failedMs,
						reducerMs,
						totalMs: (timings?.totalMs || 0) + readiness.waitMs + failedMs,
					},
					providers: {
						...providers,
						agent: executionProvider.name,
					},
					reducer: reducer.summary,
					execution: executionPlan,
					warnings: [...(warnings || []), ...liveFailureWarnings, reason],
					progress: routeProgress,
				};
			}
		}
		lastAssistantText = replyText;
		const mergedTimings: TurnTimingSummary = {
			...timings,
			agentWaitMs: readiness.waitMs,
			agentRunMs,
			reducerMs,
			...audioResult?.timings,
			totalMs:
				(timings?.totalMs || 0) + readiness.waitMs + agentRunMs + (audioResult?.timings?.ttsMs || 0),
		};
		diagnostics.recentTimings.lastRemoteTurn = mergedTimings;
		appendExecutionTrace({
			ts: Date.now(),
			source,
			rawText: trimmed,
			transcript,
			targetName: desiredTarget,
			reducerSummary: reducer.summary,
			executionPlan,
			actionPlan: makeActionPlan([
				{
					stage: "routing",
					outcome: "accepted",
					reason: executionPlan.rationale,
				},
				usedLiveMode
					? {
							stage: "dispatch",
							outcome: "succeeded",
							reason: "Dispatched via Gemini Live.",
						}
					: {
							stage: "dispatch",
							outcome: "succeeded",
							reason: `Dispatched to ${executionPlan.backend}.`,
						},
				{
					stage: "reply",
					outcome: "succeeded",
					reason: "Reply generated and delivered.",
				},
			]),
			outcome: "dispatch-success",
			timings: mergedTimings,
			replyText,
			warnings: [...(warnings || []), ...liveFailureWarnings, ...(audioResult?.warnings || [])],
			providers: {
				agent: usedLiveMode ? "gemini-live" : executionProvider.name,
				...providers,
				...audioResult?.providers,
			},
		});
		return {
			replyText,
			audioPath: audioResult?.audioPath,
			audioMimeType: audioResult?.audioMimeType,
			transcript,
			timings: mergedTimings,
			providers: {
				agent: usedLiveMode ? "gemini-live" : executionProvider.name,
				...providers,
				...audioResult?.providers,
			},
			reducer: reducer.summary,
			execution: executionPlan,
			warnings: [...(warnings || []), ...liveFailureWarnings, ...(audioResult?.warnings || [])],
			progress: routeProgress,
		};
	};

	const enqueuePhoneTurn = async (
		source: "http-text" | "http-voice" | "telegram-text" | "telegram-voice",
		text: string,
		transcript?: string,
		wantAudio = true,
		timings?: TurnTimingSummary,
		providers?: { stt?: string; tts?: string },
		warnings?: string[],
		targetName?: string,
		cwd?: string,
		mode: "auto" | "live" = "auto",
		agentProvider?: GatewayAgentProvider,
		model?: string,
	) => {
		diagnostics.recentTimings.lastRemoteSource = source;
		return await remoteTurnManager.enqueue(source, async () =>
			await executePhoneTurn(source, text, transcript, wantAudio, timings, providers, warnings, targetName, cwd, mode, agentProvider, model),
		);
	};

	const getPhoneStatusText = () => {
		const runtimeStatus = phoneBridge?.getStatus();
		const linked = runtimeStatus?.linkedChatId || phoneState.linkedChatId;
		const linkCode = runtimeStatus?.linkCode || phoneState.linkCode;
		const token = getTelegramBotToken(phoneState);
		const monoStatus = !monoActive
			? "off"
			: voiceInputActive
				? voiceTarget
					? `active -> ${voiceTarget}`
					: "active"
				: `listening for "${MONO_WAKE_PHRASE}"`;
		const rewriteStatus = isRewriteEnabled(getSpeakRuntimeState()) ? "rewrite on" : "rewrite off";
		return [
			`Phone bridge ${phoneState.enabled ? "running" : "stopped"}.`,
			token ? `Telegram token: ${maskToken(token)}.` : "Telegram token: not configured.",
			linked ? "Phone is linked." : `Awaiting link code ${linkCode || "unknown"}.`,
			`Speech replies: ${speakState.enabled ? "on" : "off"} via ${describeTtsProvider(getSpeakRuntimeState())} (${rewriteStatus}).`,
			`Mono listener: ${monoStatus}.`,
			runtimeStatus?.lastPollAt ? `Last Telegram poll: ${new Date(runtimeStatus.lastPollAt).toLocaleTimeString()}.` : "Last Telegram poll: none.",
			runtimeStatus?.consecutivePollFailures
				? `Telegram poll failures: ${runtimeStatus.consecutivePollFailures}.`
				: "Telegram poll failures: 0.",
			runtimeStatus?.lastError ? `Last phone error: ${runtimeStatus.lastError}.` : "",
		].join(" ");
	};

	const startPhoneBridge = async (ctx?: any, quiet = false) => {
		const token = getTelegramBotToken(phoneState);
		if (!token) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.(
				"Telegram is not configured. Run /phone setup, then /phone token <bot-token>.",
				"error",
			);
			return false;
		}

		if (!phoneBridge) {
			phoneBridge = new TelegramPhoneBridge({
				token,
				state: phoneState,
				getStatusText: getPhoneStatusText,
				onStateChange: (patch) => {
					const shouldPersist = Object.keys(patch).some((key) => key !== "lastUpdateId" && key !== "lastPollAt");
					syncPhoneState(patch, shouldPersist);
					if (patch.lastError) diagnostics.lastErrors.phone = patch.lastError;
				},
				onTextTurn: async (text) => {
					try {
						return await enqueuePhoneTurn("telegram-text", text);
					} catch (error) {
						if (error instanceof BusyError) {
							return { replyText: "Pi is busy, retry shortly.", busy: true };
						}
						diagnostics.lastErrors.phone = getErrorMessage(error);
						return { replyText: `Phone bridge error: ${getErrorMessage(error)}` };
					}
				},
				onVoiceBuffer: async (buffer, mimeType) => {
					try {
						const sttStartedAt = Date.now();
						const transcription = await transcribeAudioBuffer(buffer, mimeType);
						if (!transcription.text) {
							return { replyText: "I could not understand that voice message." };
						}
						return await enqueuePhoneTurn(
							"telegram-voice",
							transcription.text,
							transcription.text,
							true,
							{ sttMs: transcription.durationMs, totalMs: Date.now() - sttStartedAt },
							{ stt: transcription.provider },
						);
					} catch (error) {
						diagnostics.lastErrors.stt = getErrorMessage(error);
						return { replyText: `Voice transcription failed: ${getErrorMessage(error)}` };
					}
				},
			});
		}

		phoneBridge.start();
		const status = phoneBridge.getStatus();
		syncPhoneState(
			{
				enabled: true,
				linkedChatId: status.linkedChatId,
				linkCode: status.linkCode,
				lastUpdateId: status.lastUpdateId,
			},
			true,
		);

		if (!quiet) {
			const target = ctx || lastCtx;
			if (status.linkedChatId) {
				target?.ui?.notify?.("Phone bridge running and linked", "info");
			} else {
				target?.ui?.notify?.(
					`Phone bridge running. In Telegram, message your bot and send /link ${status.linkCode}`,
					"info",
				);
			}
		}
		return true;
	};

	const stopPhoneBridge = async (ctx?: any, quiet = false) => {
		rejectPendingPhoneTurn("Phone bridge stopped before the reply was delivered");
		if (phoneBridge) {
			await phoneBridge.stop().catch(() => {});
			phoneBridge = undefined;
		}
		syncPhoneState({ enabled: false }, true);
		if (!quiet) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.("Phone bridge stopped", "info");
		}
	};

	const getSpeakStatus = () => {
		const provider = resolveTtsProvider(getSpeakRuntimeState());
		return {
			enabled: speakState.enabled,
			configuredProvider: speakState.provider || "auto",
			provider,
			rewriteEnabled: isRewriteEnabled(getSpeakRuntimeState()),
			phase,
		};
	};

	const getMonoStatus = () => ({
		running: monoActive,
		voiceInputActive,
		target: voiceTarget,
		keepAliveSeconds: MONO_KEEP_ALIVE_SECONDS,
		status: !monoActive ? "off" : voiceInputActive ? "active" : "listening",
		lastStatus: diagnostics.listener.lastStatus,
		lastError: diagnostics.lastErrors.listener,
	});

	const getPhoneStatus = () => ({
		enabled: phoneState.enabled,
		linkedChatId: phoneState.linkedChatId,
		linkCode: phoneState.linkCode,
		lastPollAt: phoneState.lastPollAt,
		consecutivePollFailures: phoneState.consecutivePollFailures || 0,
		lastError: phoneState.lastError,
	});

	const getAgentStatus = () => {
		const provider = getAgentProvider().name;
		return {
			provider,
			configuredProvider: agentProviderConfig.provider,
			model: agentProviderConfig.model,
			capabilities: {
				textTurns: true,
				voiceTurns: true,
				audioReplies: true,
				routing: provider === "pi",
				steering: true,
			},
		};
	};

	const getRemoteStatus = () => {
		const runtime = remoteServer?.getRuntimeState();
		const queue = remoteTurnManager.getSnapshot();
		return {
			enabled: !!runtime?.enabled || remoteState.enabled,
			host: runtime?.host || remoteState.host || DEFAULT_REMOTE_HOST,
			port: runtime?.port || remoteState.port || DEFAULT_REMOTE_PORT,
			authRequired: !!(runtime?.authToken || remoteState.authToken),
			busy: queue.processing,
			queued: queue.queued,
			defaultTarget: remoteDefaultTarget,
			currentSession: pi.getSessionName() || undefined,
			availableTargets: [...new Set([...Object.keys(sessionRegistry), ...discoverOpenAgentTargetsCached()])].sort((a, b) => a.localeCompare(b)),
		};
	};

	const getRemoteStatusText = () => {
		const status = getRemoteStatus();
		const token = remoteServer?.getRuntimeState().authToken || remoteState.authToken || "";
		return [
			`Remote API ${status.enabled ? "running" : "stopped"}.`,
			`Agent: ${getAgentStatus().provider}.`,
			`Bind: ${status.host}:${status.port}.`,
			token ? "Pairing token: configured. Use /remote token only if you need to reveal it." : "Pairing token: not required.",
			status.defaultTarget ? `Route target: ${status.defaultTarget}.` : "Route target: current session.",
			"App: /app/.",
			"Endpoints: /v1/status, /v1/route, /v1/turn/text, /v1/turn/voice.",
			status.busy ? `Queue: busy with ${status.queued} queued.` : "Queue: idle.",
		].join(" ");
	};

	const getRemoteSetupText = async (mode: "tailscale" | "bluetooth" = "tailscale", includeQr = false) => {
		const runtime = remoteServer?.getRuntimeState();
		const status = getRemoteStatus();
		const token = runtime?.authToken || remoteState.authToken || "";
		const current = status.currentSession || "current session";
		const route = status.defaultTarget || current;
		const urls = buildRemoteSetupUrls(status.host, status.port, token, mode, agentProviderConfig.provider, route, agentProviderConfig.model);
		const phoneSetupUrl = urls.setupPageUrls[0] || "";
		const nativeSetupUrl = urls.appSetupUrls[0] || "";
		const downloadUrl = urls.downloadUrls[0] || "";
		const browserUrl = urls.browserUrls[0] || "/app/";
		const qr = includeQr && phoneSetupUrl ? await buildRemoteSetupQrText(phoneSetupUrl) : "";
		return [
			mode === "bluetooth" ? "Bluetooth remote setup is ready." : "PK remote setup is ready.",
			`Route: ${route}.`,
			qr ? "Scan this QR from the Android phone. It downloads the app and saves this computer, token, target session, and workspace:" : "",
			qr,
			`Phone setup page: ${phoneSetupUrl || "not available"}`,
			`Android APK: ${downloadUrl || "not available"}`,
			`Native app setup: ${nativeSetupUrl || "not available"}`,
			`Browser app: ${browserUrl}`,
			urls.browserUrls.length > 1 ? `Other local URLs: ${urls.browserUrls.slice(1).join(" ")}` : "",
			mode === "bluetooth"
				? "Pair the phone over Bluetooth networking/PAN first; the QR still carries the gateway URL and token so no API key entry is needed."
				: "No phone-side IP or API key entry is needed. Discovery uses the saved QR credentials after pairing.",
			mode === "tailscale" && !PUBLIC_REMOTE_BASE_URL && browserUrl.startsWith("http://")
				? "For browser microphone access on a phone, use HTTPS through Tailscale Serve or a tunnel and set PI_SPEAK_PUBLIC_BASE_URL."
				: "",
		].filter(Boolean).join("\n");
	};

	const startRemoteTrayForRuntime = async (ctx?: any) => {
		if (remoteTray) return true;
		const runtime = remoteServer?.getRuntimeState();
		const status = getRemoteStatus();
		const token = runtime?.authToken || remoteState.authToken || "";
		if (!token) {
			(ctx || lastCtx)?.ui?.notify?.("Remote tray needs a remote token. Start /remote on first.", "warning");
			return false;
		}
		const route = status.defaultTarget || status.currentSession;
		const urls = buildRemoteSetupUrls(status.host, status.port, token, "tailscale", agentProviderConfig.provider, route, agentProviderConfig.model);
		const baseUrl = urls.baseUrls[0] || getDefaultTailscaleBaseUrl(status.port);
		const profile = getSetupProfileForBaseUrl(baseUrl);
		const tray = await startRemoteTray({
			title: `Pi Speak - ${profile.profileName}`,
			appSetupUrl: urls.appSetupUrls[0] || "",
			setupPageUrl: urls.setupPageUrls[0] || "",
			downloadUrl: urls.downloadUrls[0] || "",
			browserUrl: urls.browserUrls[0] || "",
			baseUrl,
			profileName: profile.profileName,
		});
		if (!tray) {
			(ctx || lastCtx)?.ui?.notify?.("Remote tray is only available on Windows right now.", "warning");
			return false;
		}
		remoteTray = tray;
		tray.process.once("exit", () => {
			remoteTray = undefined;
		});
		(ctx || lastCtx)?.ui?.notify?.("Remote tray started. Right-click the tray icon for the setup QR code.", "info");
		return true;
	};

	const stopRemoteTray = () => {
		if (!remoteTray) return false;
		remoteTray.process.kill();
		remoteTray = undefined;
		return true;
	};

	const handleMonoAction = async (action: "on" | "off" | "status", ctx?: any) => {
		if (action === "on") {
			startListener(ctx);
			persistMonoState();
			return {
				ok: true,
				message: `Voice listener started. Say "${MONO_WAKE_PHRASE}" to activate (${MONO_KEEP_ALIVE_SECONDS}s keep-alive).`,
				mono: getMonoStatus(),
			};
		}
		if (action === "off") {
			stopListener(ctx);
			persistMonoState();
			return { ok: true, message: "Voice listener stopped.", mono: getMonoStatus() };
		}
		const sessions = Object.keys(sessionRegistry).join(", ") || "none";
		const status = monoActive
			? voiceInputActive
				? voiceTarget
					? `Listener running, voice active -> ${voiceTarget} (known: ${sessions})`
					: `Listener running, voice active -> current session (known: ${sessions})`
				: `Listener running, waiting for wake phrase (known: ${sessions})`
			: "Listener not running";
		return { ok: true, message: status, mono: getMonoStatus() };
	};

	const handleSpeakAction = async (
		action: "on" | "off" | "stop" | "status" | "test" | "providers" | "provider" | "rewrite",
		value?: string,
		ctx?: any,
	) => {
		if (action === "on") {
			clearRootVoiceDisable();
			enableOmpSpeechConfig();
			speakState.enabled = true;
			persistState();
			setPhase("ready", ctx);
			return {
				ok: true,
				message: `Speech mode enabled (${describeTtsProvider(getSpeakRuntimeState())}).`,
				speak: getSpeakStatus(),
			};
		}
		if (action === "stop") {
			stopSpeaking(ctx);
			return {
				ok: true,
				message: speakState.enabled ? "Stopped current speech playback." : "No speech playback is active.",
				speak: getSpeakStatus(),
			};
		}
		if (action === "off") {
			speakState.enabled = false;
			persistState();
			stopSpeaking(ctx);
			updateStatus(ctx);
			return { ok: true, message: "Speech mode disabled.", speak: getSpeakStatus() };
		}
		if (action === "status") {
			const rewriteStatus = isRewriteEnabled(getSpeakRuntimeState()) ? "rewrite on" : "rewrite off";
			return {
				ok: true,
				message: speakState.enabled
					? `Speech mode is on (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus}).`
					: `Speech mode is off (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus}).`,
				speak: getSpeakStatus(),
			};
		}
		if (action === "providers") {
			return { ok: true, message: `Available providers: ${AVAILABLE_TTS_PROVIDERS.join(", ")}`, providers: AVAILABLE_TTS_PROVIDERS };
		}
		if (action === "provider") {
			const requested = (value || "").trim().toLowerCase() as TtsProvider;
			if (!AVAILABLE_TTS_PROVIDERS.includes(requested)) {
				return { ok: false, message: `Unknown provider "${value}".`, providers: AVAILABLE_TTS_PROVIDERS };
			}
			speakState.provider = requested;
			persistState();
			stopSpeaking(ctx);
			updateStatus(ctx);
			return {
				ok: true,
				message: `Speech provider set to ${describeTtsProvider(getSpeakRuntimeState())}.`,
				speak: getSpeakStatus(),
			};
		}
		if (action === "rewrite") {
			const normalized = (value || "").trim().toLowerCase();
			if (["on", "enable", "true", "1"].includes(normalized)) {
				speakState.rewriteEnabled = true;
				persistState();
				return { ok: true, message: "Speech rewrite enabled.", speak: getSpeakStatus() };
			}
			if (["off", "disable", "false", "0"].includes(normalized)) {
				speakState.rewriteEnabled = false;
				persistState();
				return { ok: true, message: "Speech rewrite disabled.", speak: getSpeakStatus() };
			}
			return { ok: false, message: `Unknown rewrite value "${value}". Use on or off.` };
		}
		speakState.enabled = true;
		persistState();
		setPhase("ready", ctx);
		void speakText(`Hey, this is Pi speak using ${describeTtsProvider(getSpeakRuntimeState())}.`, ctx);
		return {
			ok: true,
			message: `Played speech test with ${describeTtsProvider(getSpeakRuntimeState())}.`,
			speak: getSpeakStatus(),
		};
	};

	const handlePhoneAction = async (action: "on" | "off" | "status" | "code" | "unpair", ctx?: any) => {
		if (action === "on") {
			const started = await startPhoneBridge(ctx);
			return { ok: started, message: getPhoneStatusText(), phone: getPhoneStatus() };
		}
		if (action === "off") {
			await stopPhoneBridge(ctx);
			return { ok: true, message: "Phone bridge stopped.", phone: getPhoneStatus() };
		}
		if (action === "status") {
			return { ok: true, message: getPhoneStatusText(), phone: getPhoneStatus() };
		}
		if (action === "code") {
			const started = await startPhoneBridge(ctx, true);
			if (!started || !phoneBridge) {
				return { ok: false, message: "Phone bridge could not be started." };
			}
			const status = phoneBridge.getStatus();
			return {
				ok: true,
				message: `Send /link ${status.linkCode} to your Telegram bot to pair this phone.`,
				phone: getPhoneStatus(),
			};
		}
		if (!phoneBridge) {
			syncPhoneState({ linkedChatId: undefined, linkCode: undefined }, true);
			return {
				ok: true,
				message: "Phone bridge is not running. Start it with /phone on to get a new link code.",
				phone: getPhoneStatus(),
			};
		}
		const linkCode = phoneBridge.resetLink();
		syncPhoneState({ linkedChatId: undefined, linkCode }, true);
		return { ok: true, message: `Phone unpaired. New link code: ${linkCode}.`, phone: getPhoneStatus() };
	};

	let adbReverseTimer: ReturnType<typeof setInterval> | undefined;
	let adbWarned = false;

	const getAdbPath = (): string => {
		const env = process.env;
		const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
		if (sdkRoot && existsSync(join(sdkRoot, "platform-tools", "adb.exe"))) {
			return join(sdkRoot, "platform-tools", "adb.exe");
		}
		if (sdkRoot && existsSync(join(sdkRoot, "platform-tools", "adb"))) {
			return join(sdkRoot, "platform-tools", "adb");
		}
		if (env.LOCALAPPDATA && existsSync(join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe"))) {
			return join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe");
		}
		return "adb";
	};

	const getAdbDevices = (adbPath: string): Promise<string[]> => {
		return new Promise((resolve, reject) => {
			const child = spawn(adbPath, ["devices"]);
			let stdout = "";
			child.stdout.on("data", (data) => { stdout += data.toString(); });
			child.on("error", (err) => reject(err));
			child.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`adb exited with code ${code}`));
					return;
				}
				const lines = stdout.split(/\r?\n/);
				const devices: string[] = [];
				for (const line of lines.slice(1)) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					const parts = trimmed.split(/\s+/);
					if (parts[1] === "device" && parts[0]) {
						devices.push(parts[0]);
					}
				}
				resolve(devices);
			});
		});
	};

	const reversedSerials = new Map<string, Set<number>>();

	const startAdbReverseWatcher = (ctx?: any) => {
		if (adbReverseTimer) return;
		adbWarned = false;
		reversedSerials.clear();
		const port = remoteState.port || DEFAULT_REMOTE_PORT;

		const poll = async () => {
			const adbPath = getAdbPath();
			try {
				const devices = await getAdbDevices(adbPath);
				const activeSet = new Set(devices);

				// Clean up disconnected devices
				for (const serial of reversedSerials.keys()) {
					if (!activeSet.has(serial)) {
						reversedSerials.delete(serial);
					}
				}

				if (devices.length > 0) {
					for (const serial of devices) {
						const ports = reversedSerials.get(serial) || new Set<number>();
						if (!ports.has(port)) {
							const child = spawn(adbPath, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
							child.on("error", () => {});
							child.on("close", (code) => {
								if (code === 0) {
									if (!reversedSerials.has(serial)) {
										reversedSerials.set(serial, new Set());
									}
									reversedSerials.get(serial)!.add(port);
								}
							});
						}
					}
				}
			} catch (error: any) {
				if (!adbWarned) {
					adbWarned = true;
					ctx?.ui?.notify(`ADB reverse watcher warning: could not run adb (${error.message || error})`, "warning");
				}
			}
		};

		void poll();
		adbReverseTimer = setInterval(poll, 5000);
	};

	const stopAdbReverseWatcher = () => {
		if (adbReverseTimer) {
			clearInterval(adbReverseTimer);
			adbReverseTimer = undefined;
		}
		reversedSerials.clear();
	};
	type RemoteSetupMode = "tailscale" | "bluetooth";

	const getDesiredRemoteState = (mode: RemoteSetupMode): Partial<RemoteState> => {
		if (mode === "bluetooth") {
			return {
				host: DEFAULT_ADB_REMOTE_HOST,
				port: DEFAULT_ADB_REMOTE_PORT,
			};
		}
		return {
			host: DEFAULT_REMOTE_HOST,
			port: DEFAULT_REMOTE_PORT,
		};
	};

	const shouldRestartRemoteServerForMode = (mode: RemoteSetupMode) => {
		if (!remoteServer) return false;
		const desired = getDesiredRemoteState(mode);
		const runtime = remoteServer.getRuntimeState();
		return runtime.host !== desired.host || runtime.port !== desired.port;
	};

	const stopRemoteServerRuntime = async () => {
		if (!remoteServer) return;
		await remoteServer.stop().catch(() => {});
		remoteServer = undefined;
	};

	const startRemoteServer = async (ctx?: any, quiet = false, mode: RemoteSetupMode = "tailscale") => {
		if (mode === "tailscale") {
			stopAdbReverseWatcher();
		}
		if (shouldRestartRemoteServerForMode(mode)) {
			await stopRemoteServerRuntime();
		}
		syncRemoteState(getDesiredRemoteState(mode), true);
		if (!remoteServer) {
			remoteServer = new ControlServer({
				state: remoteState,
				onStateChange: (patch) => {
					syncRemoteState(patch, true);
				},
				getStatus: () => ({
					agent: getAgentStatus(),
					speak: getSpeakStatus(),
					mono: getMonoStatus(),
					phone: getPhoneStatus(),
					remote: getRemoteStatus(),
				}),
				getDiagnostics: () => ({
					status: {
						agent: getAgentStatus(),
						speak: getSpeakStatus(),
						mono: getMonoStatus(),
						phone: getPhoneStatus(),
						remote: getRemoteStatus(),
					},
					lastErrors: diagnostics.lastErrors,
					recentTimings: diagnostics.recentTimings,
					queue: remoteTurnManager.getSnapshot(),
					providers: getTtsDiagnostics(getSpeakRuntimeState()),
					routing: getRoutingStatus(),
				}),
				getRoutingStatus,
				setRoutingTarget,
				onMonoAction: (action) => handleMonoAction(action, lastCtx),
				onSpeakAction: (action, value) => handleSpeakAction(action, value, lastCtx),
				onPhoneAction: (action) => handlePhoneAction(action, lastCtx),
				getSlashCommands: () => REMOTE_SLASH_COMMANDS,
				onTextTurn: async (text, includeAudio, target, cwd, mode, agentProvider, model) => {
					try {
						return await enqueuePhoneTurn(
							"http-text",
							text,
							undefined,
							includeAudio,
							undefined,
							undefined,
							undefined,
							target,
							cwd,
							mode,
							agentProvider,
							model,
						);
					} catch (error) {
						const reason = getErrorMessage(error);
						diagnostics.lastErrors.remote = reason;
						return {
							replyText: `Remote text turn failed: ${reason}`,
							warnings: [`Remote text turn failed: ${reason}`],
							providers: { agent: getAgentProvider().name },
						};
					}
				},
				onVoiceTurn: async (buffer, mimeType, includeAudio, target, cwd, mode, agentProvider, model) => {
					try {
						const sttStartedAt = Date.now();
						const transcription = await transcribeAudioBuffer(buffer, mimeType);
						if (!transcription.text) {
							return { replyText: "I could not understand that voice message." };
						}
						return await enqueuePhoneTurn(
							"http-voice",
							transcription.text,
							transcription.text,
							includeAudio,
							{ sttMs: transcription.durationMs, totalMs: Date.now() - sttStartedAt },
							{ stt: transcription.provider },
							undefined,
							target,
							cwd,
							mode,
							agentProvider,
							model,
						);
					} catch (error) {
						diagnostics.lastErrors.stt = getErrorMessage(error);
						return {
							replyText: `Voice transcription failed: ${getErrorMessage(error)}`,
							warnings: [`Voice transcription failed: ${getErrorMessage(error)}`],
						};
					}
				},
				onTurnCancel: () => {
					remoteTurnManager.cancelAll("Remote turn cancelled by phone.");
					return { ok: true, message: "Remote turn cancellation requested." };
				},
				getSessionDashboard: () => {
					const persisted = loadPersistedSessionRouting();
					const currentSessionPath = lastCtx?.sessionManager?.getSessionFile?.();
					const currentSessionName = pi.getSessionName?.() || undefined;
					const snapshots = readAttentionSnapshots();
					const sessionPaths = [
						...Object.values(persisted.sessions),
						currentSessionPath || undefined,
						...snapshots.map((snapshot) => snapshot.sessionPath),
					];
					const dashboard = buildSessionDashboard({
						sessions: persisted.sessions,
						aliases: persisted.aliases,
						runtimeSnapshots: snapshots,
						currentSessionPath: currentSessionPath || undefined,
						currentSessionName: currentSessionName || undefined,
						currentBusy: remoteTurnManager.getSnapshot().processing,
						currentReady: !remoteTurnManager.getSnapshot().processing,
						workingDirectories: buildSessionWorkingDirectoryMap(
							sessionPaths,
							currentSessionPath ? { [currentSessionPath]: process.cwd() } : {},
						),
						storePath: getSessionRoutingStorePath(),
					});
					return mergeOhMyPiAgentHubSessions(dashboard);
				},
				getCompactRouteSlots: () => buildCompactRouteSlots({ sessions: sessionRegistry, aliases: sessionWakeAliases }),
				agentHub: createLiveAgentHubBinding({
					dashboardFn: () => buildOhMyPiAgentHubDashboardCached(),
					submitChatTurn: (text, target, cwd) =>
						enqueuePhoneTurn("http-text", text, undefined, false, undefined, undefined, undefined, target, cwd),
				}),
				onSessionResume: (payload) => {
					const rawProvider = payload.provider?.trim();
					const provider = normalizeGatewayProviderOverride(rawProvider);
					if (rawProvider && provider !== "oh-my-pk") {
						return { ok: false, message: `Resume is not available for provider "${rawProvider}".` };
					}
					const rawSessionArg = payload.sessionId?.trim() || payload.sessionPath?.trim();
					if (!rawSessionArg) return { ok: false, message: "Session id or path is required." };
					const sessionArg = normalizeOptionalString(rawSessionArg, 1024, "session");
					if (typeof sessionArg === "object") return { ok: false, message: sessionArg.error };
					if (!sessionArg) return { ok: false, message: "Session id or path is required." };
					const cwd = payload.cwd?.trim() || DEFAULT_AGENT_CWD || process.cwd();
					try {
						const command = launchOhMyPiResume(sessionArg, cwd);
						appendSessionEvent("sess.resume", "admin", { provider: "oh-my-pk", session: sessionArg, cwd, command });
						return { ok: true, message: `Launching Oh-my-pk resume for ${sessionArg}.` };
					} catch (error) {
						return { ok: false, message: `Oh-my-pk resume failed: ${getErrorMessage(error)}` };
					}
				},
				onSessionLaunch: (payload) => launchSessionTarget(payload, "admin"),
				onHubPublish: (payload) => publishOwnerHubSession(lastCtx, payload),
				onHubResume: (payload) => resumeOwnerHubSession(lastCtx, payload),
				isHubHandoffReady: () => typeof lastCtx?.executeBuiltinCommand === "function",
				onSessionArchive: (payload) => {
					const sessionPath = payload.sessionPath;
					if (!sessionPath) return { ok: false, message: "Session path is required." };
					const result = payload.action === "recover"
						? recoverOhMyPiBackgroundSession(sessionPath)
						: archiveOhMyPiBackgroundSession(sessionPath);
					if (result.ok) {
						appendSessionEvent(payload.action === "recover" ? "sess.recover" : "sess.archive", "admin", {
							provider: "oh-my-pk",
							path: sessionPath,
						});
					}
					return { ok: result.ok, message: result.message, route: getRoutingStatus() };
				},
				onOmpSelectSession: (_clientKey, sessionPath) => {
					// Local single-user extension: one selection (default bucket) matching
					// getActiveOmpProvider(). Same shared validation as the gateway, surfaced
					// via notify/log instead of an HTTP 400. Deselect (null) always allowed.
					const validation = validateOmpSelection(sessionPath);
					if (!validation.ok) {
						appendSessionEvent("sess.ompk-select-rejected", "admin", { sessionPath, error: validation.error });
						lastCtx?.ui?.notify?.(`Can't select ompk session: ${validation.error}`, "error");
						return validation;
					}
					ompSelection.select(undefined, sessionPath);
					appendSessionEvent("sess.ompk-select", "admin", { sessionPath });
					return { ok: true };
				},
				onOmpGetSelectedSession: () => ompSelection.get(undefined),
				onSessionRename: (payload) => {
					const sessionPath = payload.sessionPath;
					const newName = payload.newName.trim();
					if (!sessionPath) return { ok: false, message: "Session path is required." };
					if (!newName) return { ok: false, message: "New name is required." };
					if (!Object.values(sessionRegistry).includes(sessionPath) && lastCtx?.sessionManager?.getSessionFile?.() !== sessionPath) {
						return { ok: false, message: "Unknown session path." };
					}
					const previousName = findSessionNameByPath(sessionPath, sessionRegistry) ?? "(unnamed)";
					const named = setNamedSession(sessionRegistry, newName, sessionPath);
					if (!named.ok) return { ok: false, message: named.error };
					sessionRegistry = named.sessions;
					persistSessionRoutingState();
					appendSessionEvent("sess.rename", "admin", { from: previousName, to: newName, path: sessionPath });
					return { ok: true, message: `Renamed ${previousName} to ${newName}.`, route: getRoutingStatus() };
				},
				onSessionAlias: (payload) => {
					const sessionPath = payload.sessionPath;
					const alias = payload.alias.trim().replace(/\s+/g, " ");
					if (!sessionPath) return { ok: false, message: "Session path is required." };
					if (!alias) return { ok: false, message: "Alias is required." };
					if (!Object.values(sessionRegistry).includes(sessionPath) && lastCtx?.sessionManager?.getSessionFile?.() !== sessionPath) {
						return { ok: false, message: "Unknown session path." };
					}
					const next = setWakeAlias(sessionWakeAliases, alias, sessionPath);
					sessionWakeAliases = next.aliases;
					persistSessionRoutingState();
					appendSessionEvent("alias.add", "admin", { alias: next.alias, name: findSessionNameByPath(sessionPath, sessionRegistry) ?? "(unnamed)", path: sessionPath });
					return { ok: true, message: `Alias "${next.alias}" added.`, route: getRoutingStatus() };
				},
				onSessionRemove: (payload) => {
					const sessionPath = payload.sessionPath;
					if (!sessionPath) return { ok: false, message: "Session path is required." };
					if (!Object.values(sessionRegistry).includes(sessionPath) && lastCtx?.sessionManager?.getSessionFile?.() !== sessionPath) {
						const archived = archiveOhMyPiBackgroundSession(sessionPath);
						if (archived.ok) {
							appendSessionEvent("sess.remove", "admin", { provider: "oh-my-pk", path: sessionPath, archived: true });
							return { ok: true, message: archived.message, route: getRoutingStatus() };
						}
						return { ok: false, message: "Unknown session path." };
					}
					const removal = removeSessionRoutingForPath(sessionRegistry, sessionWakeAliases, sessionPath);
					sessionRegistry = removal.sessions;
					sessionWakeAliases = removal.aliases;
					persistSessionRoutingState();
					appendSessionEvent("sess.remove", "admin", { path: sessionPath, removedNames: removal.removedNames, removedAliases: removal.removedAliases });
					return { ok: true, message: `Removed routing for session.`, route: getRoutingStatus() };
				},
				getDiscoveredAgents: () => discoverAgentInventoryCached(),
				tailSessionEvents,
				onRealtimeConnection: handleRealtimeGateway,
			});
		}

		const runtime = await remoteServer.start();
		syncRemoteState(
			{
				enabled: true,
				host: runtime.host,
				port: runtime.port,
				authToken: runtime.authToken,
			},
			true,
		);

		if (!quiet) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.(getRemoteStatusText(), "info");
		}
		if (isTruthy(process.env.PI_SPEAK_TRAY || "false")) {
			await startRemoteTrayForRuntime(ctx);
		}
		return true;
	};

	const stopRemoteServer = async (ctx?: any, quiet = false) => {
		remoteTurnManager.cancelAll("Remote API stopped before queued work completed");
		stopAdbReverseWatcher();
		if (remoteServer) {
			await remoteServer.stop().catch(() => {});
			remoteServer = undefined;
		}
		stopRemoteTray();
		syncRemoteState({ enabled: false }, true);
		if (!quiet) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.("Remote API stopped.", "info");
		}
	};

	const stopListener = (ctx?: any) => {
		if (listenerRl) {
			try { listenerRl.close(); } catch {}
			listenerRl = undefined;
		}
		if (listenerProcess && !listenerProcess.killed) {
			requestGracefulChildShutdown(listenerProcess, { command: "shutdown", killAfterMs: 3000 });
		}
		listenerProcess = undefined;
		monoActive = false;
		voiceInputActive = false;
		voiceTarget = undefined;
		diagnostics.listener.lastExitedAt = Date.now();
		diagnostics.listener.lastStatus = "Listener stopped";
		updateMonoStatus(ctx);
	};

	const startListener = (ctx?: any) => {
		if (listenerProcess) return;

		const extDir = getExtensionDir();
		const listenerScript = join(extDir, "listener", "listener.py");
		if (!existsSync(listenerScript)) {
			const target = ctx || lastCtx;
			diagnostics.lastErrors.listener = `Listener script not found: ${listenerScript}`;
			target?.ui?.notify?.(`Listener script not found: ${listenerScript}`, "error");
			return;
		}

		const python = getPython();
		listenerProcess = spawn(python, ["-u", listenerScript], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
			shell: false,
			env: getListenerPythonEnv(),
		});

		monoActive = true;
		diagnostics.listener.lastStartedAt = Date.now();
		diagnostics.listener.lastStatus = "Voice listener starting";
		diagnostics.lastErrors.listener = undefined;
		updateMonoStatus(ctx);

		listenerRl = createInterface({ input: listenerProcess.stdout! });
		listenerRl.on("line", (line) => {
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (!isListenerEvent(event)) return;
			// Always use lastCtx so voice events target the current session, not the
			// stale ctx from when startListener was called.
			handleListenerEvent(event, undefined);
		});

		listenerProcess.stderr?.setEncoding("utf8");
		listenerProcess.stderr?.on("data", (chunk: string) => {
			for (const line of chunk.split(/\r?\n/)) {
				if (line.trim()) {
					const target = ctx || lastCtx;
					diagnostics.lastErrors.listener = line.trim();
					target?.ui?.notify?.(`[listener] ${line.trim()}`, "warning");
				}
			}
		});

		listenerProcess.on("exit", (code) => {
			listenerProcess = undefined;
			monoActive = false;
			voiceInputActive = false;
			voiceTarget = undefined;
			updateMonoStatus(ctx);
			if (code !== 0 && code !== null) {
				const target = ctx || lastCtx;
				diagnostics.lastErrors.listener = `Voice listener exited with code ${code}`;
				target?.ui?.notify?.(`Voice listener exited with code ${code}`, "error");
			}
		});

		listenerProcess.on("error", (err) => {
			listenerProcess = undefined;
			monoActive = false;
			voiceInputActive = false;
			voiceTarget = undefined;
			updateMonoStatus(ctx);
			const target = ctx || lastCtx;
			diagnostics.lastErrors.listener = err.message;
			target?.ui?.notify?.(`Voice listener error: ${err.message}`, "error");
		});
	};

	const handleListenerEvent = (event: ListenerEvent, ctx?: any) => {
		const target = ctx || lastCtx;

		switch (event.type) {
			case "wake":
				if (event.state === "on") {
					voiceInputActive = true;
					voiceTarget = event.target || undefined;
					updateMonoStatus(target);
					const cue = playMonoCue("listening");
					cue.on("error", () => {});
					if (!speakState.enabled && !isRootVoiceDisabled()) {
						speakState.enabled = true;
						persistState();
						setPhase("ready", target);
					}
					const targetLabel = voiceTarget ? ` (target: ${voiceTarget})` : "";
					target?.ui?.notify?.(`Listening now${targetLabel} - speak your request, then say "${MONO_WAKE_PHRASE}" again to keep alive`, "info");
				} else if (event.state === "ping") {
					// Keep-alive â€” update target if provided
					if (event.target) voiceTarget = event.target;
					updateMonoStatus(target);
				} else if (event.state === "off") {
					voiceInputActive = false;
					voiceTarget = undefined;
					updateMonoStatus(target);
					const cue = playMonoCue("idle");
					cue.on("error", () => {});
					const reason = event.reason === "timeout" ? " (timed out)" : "";
					target?.ui?.notify?.(`Voice input off${reason} - say "${MONO_WAKE_PHRASE}" to reactivate`, "info");
				}
				break;

			case "transcribing":
				diagnostics.listener.lastStatus = "Transcribing";
				target?.ui?.setStatus?.("mono", "mono:transcribing");
				break;

			case "speech":
				updateMonoStatus(target);
				if (event.text && voiceInputActive) {
					void routeVoiceInput(event.text, target);
				}
				break;

			case "status":
				diagnostics.listener.lastStatus = event.message;
				break;

			case "error":
				diagnostics.lastErrors.listener = event.message;
				notifyAudible(target, `[listener] ${event.message}`, "error", `Voice listener error. ${event.message}`);
				break;
		}
	};

	const routeVoiceInput = async (text: string, ctx?: any) => {
		const lower = text.toLowerCase().trim();
		const target = ctx || lastCtx;

		// Speech control -- always immediate, no agent interaction
		if (isSpeechInterruptCommand(lower)) {
			stopSpeaking(target);
			return;
		}

		// Tool-use approval gate. When the agent asks to run a shell command or
		// touch a file, the host suspends the turn via approvalRegistry.request
		// and we resolve it here from the next voice utterance.
		const pendingApproval = approvalRegistry.get();
		if (pendingApproval) {
			if (isAffirmative(text)) {
				notifyAudible(target, `Approving: ${pendingApproval.description}`, "info", `Approved.`);
				approvalRegistry.accept();
				return;
			}
			if (isNegative(text)) {
				notifyAudible(target, `Declining: ${pendingApproval.description}`, "info", `Declined.`);
				approvalRegistry.decline();
				return;
			}
			// Anything else — fall through; the request expires per its TTL and
			// the agent receives a decline. Avoids hijacking unrelated speech.
		}

		// Voice confirmation gate. If a pending action (today: /sess remove) is
		// awaiting confirmation, treat yes/no replies as the consume signal so
		// the operator never has to say the literal "/sess confirm remove X".
		if (pendingSessionRemoval && (Date.now() - pendingSessionRemoval.requestedAt) <= SESSION_REMOVE_CONFIRM_TTL_MS) {
			if (isAffirmative(text)) {
				const name = pendingSessionRemoval.sessionName;
				target?.ui?.notify?.(`Confirming removal of ${name}.`, "info");
				if (speakState.enabled) void speakText(`Removing session ${name}.`, target);
				await handleSessCommand(`confirm remove ${name}`, target, "voice");
				return;
			}
			if (isNegative(text)) {
				const name = pendingSessionRemoval.sessionName;
				pendingSessionRemoval = undefined;
				target?.ui?.notify?.(`Cancelled removal of ${name}.`, "info");
				if (speakState.enabled) void speakText(`Cancelled.`, target);
				return;
			}
			// Anything else — fall through; pending entry expires per TTL.
		}

		// Voice playback over the saved last assistant reply. All operations
		// here are extractive (regex / verbatim replay) — no LLM round-trip,
		// so no context rot.
		const playback = parsePlaybackCommand(text);
		if (playback) {
			const saved = lastAssistantText.trim();
			if (!saved) {
				notifyAudible(target, "No previous reply to play back.", "info", "I haven't said anything yet.");
				return;
			}
			if (playback === "repeat") {
				notifyAudible(target, "Repeating last reply.", "info");
				if (speakState.enabled) void speakText(saved, target);
				return;
			}
			if (playback === "read-error") {
				const errors = extractErrors(saved);
				if (!errors) {
					notifyAudible(target, "No errors found in the last reply.", "info", "No errors found.");
					return;
				}
				notifyAudible(target, `Reading errors:\n${errors}`, "info");
				if (speakState.enabled) void speakText(errors, target);
				return;
			}
			if (playback === "read-diff") {
				const diff = extractDiff(saved);
				if (!diff) {
					notifyAudible(target, "No diff found in the last reply.", "info", "No diff found.");
					return;
				}
				notifyAudible(target, `Reading diff:\n${diff}`, "info");
				if (speakState.enabled) void speakText(diff, target);
				return;
			}
		}

		// Determine if agent is busy so we can queue instead of interrupt
		const idle = target?.isIdle?.() ?? true;
		const deliverAs = idle ? undefined : ("followUp" as const);

		if (!idle) {
			target?.ui?.setStatus?.("mono", "mono:queued");
		}

		// Session commands via voice — route through the parser so mutations are tagged source="voice"
		const voiceMatch = parseVoiceSlashCommand(text);
		if (voiceMatch && voiceMatch.command.startsWith("/sess")) {
			const sessArgs = voiceMatch.command.slice("/sess".length).trim();
			if (target) {
				await handleSessCommand(sessArgs, target, "voice");
				return;
			}
			pendingSessSource = "voice";
			pi.sendUserMessage(voiceMatch.command, deliverAs ? { deliverAs } : undefined);
			return;
		}

		// Everything else -> user message to Pi (queued as followUp if busy)
		if (voiceTarget) {
			const sessionMatch = resolveSessionByName(voiceTarget);
			if (getAgentProvider().name === "pi" && sessionMatch && typeof target?.switchSession === "function") {
				// Audible wake echo so headphone-only operators hear where the
				// utterance was routed before the agent reply lands.
				notifyAudible(
					target,
					`Routing to session: ${sessionMatch.sessionName}`,
					"info",
					`Routing to ${sessionMatch.sessionName}.`,
				);
				const result = await target.switchSession(sessionMatch.sessionPath);
				if (!result?.cancelled) {
					pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
				}
				return;
			} else {
				notifyAudible(
					target,
					`Unknown session "${voiceTarget}" - say "${MONO_WAKE_PHRASE}" to reset to current`,
					"warning",
					`Unknown session ${voiceTarget}. Say ${MONO_WAKE_PHRASE} to reset.`,
				);
			}
		}
		if (getAgentProvider().name === "pi") {
			pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
			return;
		}
		try {
			const replyText = await runAgentPrompt(text, { mode: deliverAs || "turn", timeoutMs: PHONE_TURN_WAIT_TIMEOUT_MS });
			lastAssistantText = replyText;
			target?.ui?.notify?.(replyText.slice(0, 1200), "info");
			if (speakState.enabled) void speakText(replyText, target);
		} catch (error) {
			const message = getErrorMessage(error);
			diagnostics.lastErrors.remote = message;
			notifyAudible(target, `Agent provider failed: ${message}`, "error", `Agent failed. ${message}`);
		}
	};

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------
	pi.registerCommand("mono", {
		description: "Control the always-on voice listener (faster-whisper wake detection + transcription)",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();

			if (!lower || lower === "on" || lower === "start") {
				startListener(ctx);
				persistMonoState();
				ctx.ui.notify(`Voice listener started - say "${MONO_WAKE_PHRASE}" to activate (${MONO_KEEP_ALIVE_SECONDS}s keep-alive)`, "info");
				return;
			}

			if (lower === "off" || lower === "stop") {
				stopListener(ctx);
				persistMonoState();
				ctx.ui.notify("Voice listener stopped", "info");
				return;
			}

			if (lower === "status") {
				const sessions = Object.keys(sessionRegistry).join(", ") || "none";
				const status = monoActive
					? voiceInputActive
						? voiceTarget
							? `Listener running, voice active â†’ ${voiceTarget} (known: ${sessions})`
							: `Listener running, voice active â†’ current session (known: ${sessions})`
						: `Listener running, waiting for wake phrase (known: ${sessions})`
					: "Listener not running";
				ctx.ui.notify(status, "info");
				return;
			}

			ctx.ui.notify("Usage: /mono [on|off|status]", "error");
		},
	});

	const handleSessCommand = async (args: string, ctx: any, source: SessionEventSource = "command") => {
			lastCtx = ctx;
			reloadSessionRoutingIfExternallyChanged();
			const raw = args.trim();
			const parts = raw ? raw.split(/\s+/) : [];
			const sub = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ").trim();

			if (!sub || sub === "list" || sub === "status") {
				ctx.ui.notify(getSessionManagerSummaryText(ctx), "info");
				return;
			}

			if (sub === "slots") {
				ctx.ui.notify(formatCompactRouteSlots({ sessions: sessionRegistry, aliases: sessionWakeAliases }), "info");
				return;
			}

			if (sub === "ui") {
				if (rest !== "open") {
					ctx.ui.notify(
						[
							getSessionManagerSummaryText(ctx),
							"",
							"Terminal pane is no longer opened by default. Use /sess, /sess slots, or the phone remote for normal routing. If you really need the old terminal pane, run /sess ui open.",
						].join("\n"),
						"info",
					);
					return;
				}
				const result = launchSessionManagerPane({
					currentSessionPath: ctx.sessionManager.getSessionFile?.() || undefined,
					currentSessionName: pi.getSessionName() || undefined,
				});
				if (result.spawned) {
					ctx.ui.notify(`Opened session manager pane in a new terminal. Run manually with: ${result.manualCommand}`, "info");
				} else if (result.reused) {
					ctx.ui.notify(result.reason || "Session manager pane is already running.", "info");
				} else {
					const reason = result.reason ? `${result.reason} ` : "";
					ctx.ui.notify(`${reason}Run manually: ${result.manualCommand}`, "warning");
				}
				return;
			}

			if (sub === "launch") {
				if (!rest) {
					ctx.ui.notify("Usage: /sess launch [colab|hub|<agent prompt>]", "error");
					return;
				}
				const launchTarget = rest.toLowerCase().replace(/\s+/g, " ").trim();
				const payload: SessionLaunchPayload = { cwd: DEFAULT_AGENT_CWD || process.cwd() };
				if (["hub", "agent hub", "ompk hub", "oh-my-pk hub", "omp hub", "oh-my-pi hub"].includes(launchTarget)) {
					payload.hubOnly = true;
				} else if (
					["colab", "google colab", "colab workspace", "colab deploy", "colab launch"].includes(launchTarget)
					|| launchTarget.startsWith("colab ")
				) {
					payload.targetNode = "colab";
				} else {
					payload.prompt = rest;
				}
				const result = launchSessionTarget(payload, source);
				notifyAudible(ctx, result.message, result.ok ? "info" : "error", source === "voice" ? result.message : undefined);
				return;
			}

			if (sub === "new") {
				const name = rest || `session-${Date.now()}`;
				const conflictText = getSessionRouteConflictText(name, ctx);
				if (conflictText) {
					ctx.ui.notify(conflictText, "error");
					return;
				}
				const existing = setNamedSession(sessionRegistry, name, `pending:${name}`);
				if (!existing.ok) {
					ctx.ui.notify(existing.error, "error");
					return;
				}
				const result = await ctx.newSession();
				if (!result.cancelled) {
					pi.setSessionName(name);
					const sessionFile = ctx.sessionManager.getSessionFile();
					if (sessionFile) {
						const named = setNamedSession(sessionRegistry, name, sessionFile);
						if (named.ok) {
							sessionRegistry = named.sessions;
							persistSessionRegistry();
						}
					}
					appendSessionEvent("sess.new", source, { name, path: ctx.sessionManager.getSessionFile() || `pending:${name}` });
					ctx.ui.notify(`New session: ${name}`, "info");
				}
				return;
			}

			if (sub === "switch") {
				if (!rest) {
					ctx.ui.notify("Usage: /sess switch <name-or-alias>", "error");
					return;
				}
				const sessionMatch = resolveSessionByName(rest);
				if (!sessionMatch) {
					ctx.ui.notify(`Session "${rest}" not found. Known: ${getKnownTargetsText()}`, "error");
					return;
				}
				const result = await ctx.switchSession(sessionMatch.sessionPath);
				if (!result.cancelled) {
					appendSessionEvent("sess.switch", source, { name: sessionMatch.sessionName, path: sessionMatch.sessionPath });
					ctx.ui.notify(`Switched to session: ${sessionMatch.sessionName}`, "info");
				}
				return;
			}

			if (sub === "rename") {
				const [targetName, ...restParts] = rest.split(/\s+/).filter(Boolean);
				const nextName = restParts.join(" ").trim();
				if (!targetName || !nextName) {
					ctx.ui.notify("Usage: /sess rename <name-or-alias> <new-name>", "error");
					return;
				}
				const sessionMatch = resolveSessionByName(targetName);
				if (!sessionMatch) {
					ctx.ui.notify(`Session "${targetName}" not found. Known: ${getKnownTargetsText()}`, "error");
					return;
				}
				const conflictText = getSessionRouteConflictText(nextName, ctx);
				if (conflictText && sessionMatch.sessionPath !== ctx.sessionManager.getSessionFile()) {
					ctx.ui.notify(conflictText, "error");
					return;
				}
				const named = setNamedSession(sessionRegistry, nextName, sessionMatch.sessionPath);
				if (!named.ok) {
					ctx.ui.notify(named.error, "error");
					return;
				}
				sessionRegistry = named.sessions;
				if (ctx.sessionManager.getSessionFile() === sessionMatch.sessionPath) {
					pi.setSessionName(nextName);
				}
				persistSessionRegistry();
				appendSessionEvent("sess.rename", source, { from: sessionMatch.sessionName, to: nextName, path: sessionMatch.sessionPath });
				ctx.ui.notify(`Session renamed: ${sessionMatch.sessionName} → ${nextName}`, "info");
				return;
			}

			if (sub === "alias") {
				const aliasSub = (parts[1] || "").toLowerCase();
				const aliasRest = parts.slice(2).join(" ").trim();
				if (!aliasSub || aliasSub === "list") {
					ctx.ui.notify(getSessionManagerSummaryText(ctx), "info");
					return;
				}
				if (aliasSub === "remove" || aliasSub === "clear") {
					if (!aliasRest) {
						ctx.ui.notify("Usage: /sess alias remove <alias>", "error");
						return;
					}
					const cleared = clearWakeAlias(sessionWakeAliases, aliasRest);
					if (!cleared.ok) {
						ctx.ui.notify(`Wake alias "${aliasRest}" not found`, "error");
						return;
					}
					sessionWakeAliases = cleared.aliases;
					persistSessionWakeAliases();
					appendSessionEvent("alias.remove", source, { alias: cleared.alias });
					ctx.ui.notify(`Wake alias cleared: ${cleared.alias}`, "info");
					return;
				}
				if (aliasSub === "add") {
					const [targetName, ...aliasParts] = aliasRest.split(/\s+/).filter(Boolean);
					const aliasName = aliasParts.join(" ").trim();
					if (!targetName || !aliasName) {
						ctx.ui.notify("Usage: /sess alias add <session> <alias>", "error");
						return;
					}
					const sessionMatch = resolveSessionByName(targetName);
					if (!sessionMatch) {
						ctx.ui.notify(`Session "${targetName}" not found. Known: ${getKnownTargetsText()}`, "error");
						return;
					}
					const nextAlias = setWakeAlias(sessionWakeAliases, aliasName, sessionMatch.sessionPath);
					sessionWakeAliases = nextAlias.aliases;
					persistSessionWakeAliases();
					appendSessionEvent("alias.add", source, { alias: aliasName, name: sessionMatch.sessionName, path: sessionMatch.sessionPath });
					ctx.ui.notify(`Wake alias "${aliasName}" now routes to ${sessionMatch.sessionName}. Say "${MONO_WAKE_PHRASE} ${aliasName}".`, "info");
					return;
				}
				ctx.ui.notify("Usage: /sess alias [add <session> <alias>|remove <alias>|list]", "error");
				return;
			}

			if (sub === "edit") {
				if (!rest) {
					ctx.ui.notify(`${getSessionManagerSummaryText(ctx)}\n\nTip: use /sess edit <session> to show shortcuts.`, "info");
					return;
				}
				const actionParts = rest.split(/\s+/).filter(Boolean);
				const targetName = actionParts[0];
				const sessionMatch = resolveSessionByName(targetName);
				if (!sessionMatch) {
					ctx.ui.notify(`Session "${targetName}" not found. Known: ${getKnownTargetsText()}`, "error");
					return;
				}
				const remainder = actionParts.slice(1).join(" ").trim();
				if (!remainder) {
					ctx.ui.notify(getSessionEditGuideText(sessionMatch.sessionPath, sessionMatch.sessionName, ctx), "info");
					return;
				}
				if (remainder === "switch") {
					const result = await ctx.switchSession(sessionMatch.sessionPath);
					if (!result.cancelled) {
						appendSessionEvent("sess.switch", source, { name: sessionMatch.sessionName, path: sessionMatch.sessionPath });
						ctx.ui.notify(`Switched to session: ${sessionMatch.sessionName}`, "info");
					}
					return;
				}
				if (remainder.startsWith("rename ")) {
					const nextName = remainder.slice("rename ".length).trim();
					const named = setNamedSession(sessionRegistry, nextName, sessionMatch.sessionPath);
					if (!named.ok) {
						ctx.ui.notify(named.error, "error");
						return;
					}
					sessionRegistry = named.sessions;
					if (ctx.sessionManager.getSessionFile() === sessionMatch.sessionPath) pi.setSessionName(nextName);
					persistSessionRegistry();
					appendSessionEvent("sess.rename", source, { from: sessionMatch.sessionName, to: nextName, path: sessionMatch.sessionPath });
					ctx.ui.notify(`Session renamed: ${sessionMatch.sessionName} → ${nextName}`, "info");
					return;
				}
				if (remainder.startsWith("alias add ")) {
					const aliasName = remainder.slice("alias add ".length).trim();
					const nextAlias = setWakeAlias(sessionWakeAliases, aliasName, sessionMatch.sessionPath);
					sessionWakeAliases = nextAlias.aliases;
					persistSessionWakeAliases();
					appendSessionEvent("alias.add", source, { alias: aliasName, name: sessionMatch.sessionName, path: sessionMatch.sessionPath });
					ctx.ui.notify(`Wake alias "${aliasName}" now routes to ${sessionMatch.sessionName}. Say "${MONO_WAKE_PHRASE} ${aliasName}".`, "info");
					return;
				}
				if (remainder.startsWith("alias remove ")) {
					const aliasName = remainder.slice("alias remove ".length).trim();
					const cleared = clearWakeAlias(sessionWakeAliases, aliasName);
					if (!cleared.ok) {
						ctx.ui.notify(`Wake alias "${aliasName}" not found`, "error");
						return;
					}
					sessionWakeAliases = cleared.aliases;
					persistSessionWakeAliases();
					appendSessionEvent("alias.remove", source, { alias: cleared.alias });
					ctx.ui.notify(`Wake alias cleared: ${cleared.alias}`, "info");
					return;
				}
				if (remainder === "remove") {
					pendingSessionRemoval = { sessionPath: sessionMatch.sessionPath, sessionName: sessionMatch.sessionName, requestedAt: Date.now() };
					ctx.ui.notify(`Confirm with /sess confirm remove ${sessionMatch.sessionName}. This removes the saved session name and aliases from the local routing store. It does not delete the underlying Pi session file.`, "warning");
					if (source === "voice" && speakState.enabled) {
						void speakText(`About to remove session ${sessionMatch.sessionName}. Say yes to confirm or no to cancel.`, ctx);
					}
					return;
				}
				ctx.ui.notify(`Unknown edit action "${remainder}". Use /sess edit ${targetName} to see shortcuts.`, "error");
				return;
			}

			if (sub === "remove" || sub === "delete") {
				if (!rest) {
					ctx.ui.notify("Usage: /sess remove <name-or-alias>", "error");
					return;
				}
				const sessionMatch = resolveSessionByName(rest);
				if (!sessionMatch) {
					ctx.ui.notify(`Session "${rest}" not found. Known: ${getKnownTargetsText()}`, "error");
					return;
				}
				pendingSessionRemoval = { sessionPath: sessionMatch.sessionPath, sessionName: sessionMatch.sessionName, requestedAt: Date.now() };
				ctx.ui.notify(`Confirm with /sess confirm remove ${sessionMatch.sessionName}. This removes the saved session name and aliases from the local routing store. It does not delete the underlying Pi session file.`, "warning");
				if (source === "voice" && speakState.enabled) {
					void speakText(`About to remove session ${sessionMatch.sessionName}. Say yes to confirm or no to cancel.`, ctx);
				}
				return;
			}

			if (sub === "confirm" && (parts[1] || "").toLowerCase() === "remove") {
				if (!pendingSessionRemoval || (Date.now() - pendingSessionRemoval.requestedAt) > SESSION_REMOVE_CONFIRM_TTL_MS) {
					pendingSessionRemoval = undefined;
					ctx.ui.notify("No pending session removal confirmation is active.", "error");
					return;
				}
				const removedPath = pendingSessionRemoval.sessionPath;
				const removal = removeSessionRoutingForPath(sessionRegistry, sessionWakeAliases, removedPath);
				sessionRegistry = removal.sessions;
				sessionWakeAliases = removal.aliases;
				if (ctx.sessionManager.getSessionFile() === removedPath) pi.setSessionName("");
				persistSessionRegistry();
				persistSessionWakeAliases();
				const removedLabel = pendingSessionRemoval.sessionName;
				pendingSessionRemoval = undefined;
				appendSessionEvent("sess.remove", source, { name: removedLabel, path: removedPath });
				ctx.ui.notify(`Removed saved session metadata for ${removedLabel}.`, "info");
				return;
			}

			if (sub === "export") {
				persistSessionRoutingState();
				ctx.ui.notify(describeSessionRoutingStore(getSessionRoutingStorePath(), { sessions: sessionRegistry, aliases: sessionWakeAliases }), "info");
				return;
			}

			if (sub === "name") {
				if (!rest) {
					const current = pi.getSessionName();
					ctx.ui.notify(current ? `Current: ${current}` : "No session name set", "info");
					return;
				}
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify("No active session file is available for naming", "error");
					return;
				}
				const named = setNamedSession(sessionRegistry, rest, sessionFile);
				if (!named.ok) {
					ctx.ui.notify(named.error, "error");
					return;
				}
				pi.setSessionName(rest);
				sessionRegistry = named.sessions;
				persistSessionRegistry();
				appendSessionEvent("sess.name", source, { name: rest, path: sessionFile });
				ctx.ui.notify(`Session named: ${rest}`, "info");
				return;
			}

			if (sub === "wake") {
				const wakeSub = (parts[1] || "").toLowerCase();
				const aliasRest = parts.slice(2).join(" ").trim();
				if (!rest || wakeSub === "list") {
					ctx.ui.notify(getSessionManagerSummaryText(ctx), "info");
					return;
				}
				if (wakeSub === "clear") {
					const cleared = clearWakeAlias(sessionWakeAliases, aliasRest);
					if (!cleared.ok) {
						ctx.ui.notify(`Wake alias "${aliasRest}" not found`, "error");
						return;
					}
					sessionWakeAliases = cleared.aliases;
					persistSessionWakeAliases();
					appendSessionEvent("alias.remove", source, { alias: cleared.alias });
					ctx.ui.notify(`Wake alias cleared: ${cleared.alias}`, "info");
					return;
				}
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify("No active session file is available for wake alias registration", "error");
					return;
				}
				const nextAlias = setWakeAlias(sessionWakeAliases, rest, sessionFile);
				sessionWakeAliases = nextAlias.aliases;
				persistSessionWakeAliases();
				appendSessionEvent("alias.add", source, { alias: rest, name: pi.getSessionName() || "", path: sessionFile });
				ctx.ui.notify(`Wake alias "${rest}" now routes to ${pi.getSessionName() || "this session"}. Say "${MONO_WAKE_PHRASE} ${rest}".`, "info");
				return;
			}

			ctx.ui.notify("Usage: /sess [new|switch|rename|edit|alias|remove|confirm remove|launch|list|name|wake|slots|ui|export] <args>", "error");
	};

	pi.registerCommand("sess", {
		description: "Manage named sessions, wake aliases, slot lanes, and routing summaries",
		getArgumentCompletions: (prefix) => getSessCompletions(prefix),
		handler: async (args, ctx) => {
			const source = pendingSessSource ?? "command";
			pendingSessSource = undefined;
			await handleSessCommand(args, ctx, source);
		},
	});

	pi.registerCommand("_sessVoice", {
		description: "(internal) voice-originated /sess dispatch",
		handler: async (args, ctx) => {
			await handleSessCommand(args, ctx, "voice");
		},
	});

	pi.registerCommand("phone", {
		description: "Remote Pi over Telegram text and voice messages",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "setup", "token", "code", "unpair"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();

			if (!lower || lower === "on" || lower === "start") {
				await startPhoneBridge(ctx);
				return;
			}

			if (lower === "setup") {
				const token = getTelegramBotToken(phoneState);
				const status = phoneBridge?.getStatus();
				ctx.ui.notify(
					[
						"Telegram phone setup:",
						token ? `Token is configured (${maskToken(token)}).` : "1. In Telegram, message @BotFather, create or reuse a bot, and copy its token.",
						token ? "Run /phone on, then /phone code if you need the pair code." : "2. Run /phone token <bot-token> here.",
						status?.linkCode ? `3. Send /link ${status.linkCode} to your bot from your phone.` : "3. Run /phone code and send the printed /link code to your bot.",
					].join(" "),
					"info",
				);
				return;
			}

			if (lower.startsWith("token ")) {
				const token = args.slice(args.toLowerCase().indexOf("token") + "token".length).trim();
				if (!token) {
					ctx.ui.notify("Usage: /phone token <telegram-bot-token>", "error");
					return;
				}
				if (phoneBridge) {
					await stopPhoneBridge(ctx);
					phoneBridge = undefined;
				}
				syncPhoneState({ botToken: token, enabled: false, linkedChatId: undefined, linkCode: undefined }, true);
				const started = await startPhoneBridge(ctx, true);
				const bridge = phoneBridge as TelegramPhoneBridge | undefined;
				if (!started || !bridge) {
					ctx.ui.notify(`Telegram token saved (${maskToken(token)}). Run /phone on when ready.`, "info");
					return;
				}
				const status = bridge.getStatus();
				ctx.ui.notify(`Telegram token saved (${maskToken(token)}). Send /link ${status.linkCode} to your bot to pair this phone.`, "info");
				return;
			}

			if (lower === "off" || lower === "stop") {
				await stopPhoneBridge(ctx);
				return;
			}

			if (lower === "status") {
				const status = phoneBridge?.getStatus();
				const linkHint =
					status && !status.linkedChatId
						? ` Send /link ${status.linkCode} to your bot in Telegram.`
						: "";
				ctx.ui.notify(`${getPhoneStatusText()}${linkHint}`, "info");
				return;
			}

			if (lower === "code") {
				const started = await startPhoneBridge(ctx, true);
				if (!started || !phoneBridge) return;
				const status = phoneBridge.getStatus();
				ctx.ui.notify(`Send /link ${status.linkCode} to your Telegram bot to pair this phone`, "info");
				return;
			}

			if (lower === "unpair") {
				if (!phoneBridge) {
					syncPhoneState({ linkedChatId: undefined, linkCode: undefined }, true);
					ctx.ui.notify("Phone bridge is not running. Start it with /phone on to get a new link code.", "info");
					return;
				}
				const linkCode = phoneBridge.resetLink();
				syncPhoneState({ linkedChatId: undefined, linkCode }, true);
				ctx.ui.notify(`Phone unpaired. New link code: ${linkCode}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /phone [on|off|status|setup|token <bot-token>|code|unpair]", "error");
		},
	});

	pi.registerCommand("remote", {
		description: "Control Pi through the local HTTP API for phone remotes and automations",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "token", "setup", "setup bluetooth", "tray on", "tray off", "tray status", "launch", "launch bluetooth"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();

			if (!lower || lower === "on" || lower === "start" || lower === "launch" || lower === "launch bluetooth") {
				const mode: RemoteSetupMode = lower.includes("bluetooth") ? "bluetooth" : "tailscale";
				await startRemoteServer(ctx, lower.startsWith("launch"), mode);
				if (lower === "launch bluetooth") {
					startAdbReverseWatcher(ctx);
				}
				if (lower.startsWith("launch")) {
					ctx.ui.notify(await getRemoteSetupText(mode, true), "info");
				}
				return;
			}

			if (lower === "off" || lower === "stop") {
				await stopRemoteServer(ctx);
				return;
			}

			if (lower === "status") {
				ctx.ui.notify(getRemoteStatusText(), "info");
				return;
			}

			if (lower === "setup") {
				await startRemoteServer(ctx, true, "tailscale");
				ctx.ui.notify(await getRemoteSetupText("tailscale", true), "info");
				return;
			}

			if (lower === "setup bluetooth" || lower === "bluetooth setup") {
				await startRemoteServer(ctx, true, "bluetooth");
				ctx.ui.notify(await getRemoteSetupText("bluetooth", true), "info");
				return;
			}

			if (lower === "token") {
				if (!remoteServer && !remoteState.authToken) {
					await startRemoteServer(ctx, true);
				}
				const token = remoteServer?.getRuntimeState().authToken || remoteState.authToken || "";
				if (!token) {
					ctx.ui.notify("No remote token is configured yet. Start the remote API with /remote on.", "warning");
					return;
				}
				ctx.ui.notify(`Remote token: ${token}`, "info");
				return;
			}

			if (lower === "tray" || lower === "tray on") {
				await startRemoteServer(ctx, true);
				await startRemoteTrayForRuntime(ctx);
				return;
			}

			if (lower === "tray off") {
				const stopped = stopRemoteTray();
				ctx.ui.notify(stopped ? "Remote tray stopped." : "Remote tray is not running.", "info");
				return;
			}

			if (lower === "tray status") {
				ctx.ui.notify(remoteTray ? "Remote tray is running." : "Remote tray is not running.", "info");
				return;
			}

			ctx.ui.notify("Usage: /remote [on|off|status|token|setup|setup bluetooth|tray on|tray off|tray status] or /pk-remote", "error");
		},
	});

	pi.registerCommand("pk-remote", {
		description: "Start the phone remote and show a QR code that configures the Android app",
		getArgumentCompletions: (prefix) => {
			const options = ["", "bluetooth"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value || "setup" })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();
			const mode = lower === "bluetooth" || lower === "setup bluetooth" || lower === "bluetooth setup"
				? "bluetooth"
				: "tailscale";
			await startRemoteServer(ctx, true, mode);
			ctx.ui.notify(await getRemoteSetupText(mode, true), "info");
		},
	});

	pi.registerCommand("pk-remote-launch", {
		description: "Start the phone remote, show the setup QR, and supervise ADB reverse port forwarding",
		getArgumentCompletions: (prefix) => {
			const options = ["", "bluetooth"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value || "setup" })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();
			const mode = lower === "bluetooth" || lower === "setup bluetooth" || lower === "bluetooth setup"
				? "bluetooth"
				: "tailscale";
			await startRemoteServer(ctx, true, mode);
			if (mode === "bluetooth") {
				startAdbReverseWatcher(ctx);
			}
			ctx.ui.notify(await getRemoteSetupText(mode, true), "info");
		},
	});

	pi.registerCommand("speak", {
		description: "Enable spoken assistant replies with provider selection",
		getArgumentCompletions: (prefix) => {
			const options = [
				"on",
				"off",
				"stop",
				"status",
				"test",
				"providers",
				"provider auto",
				"provider legacy",
				"provider edge",
				"provider gemini",
				"provider openai",
				"provider elevenlabs",
				"rewrite on",
				"rewrite off",
			];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const raw = args.trim();
			const lower = raw.toLowerCase();

			if (!raw || lower === "on" || lower === "enable" || lower === "start") {
				clearRootVoiceDisable();
				enableOmpSpeechConfig();
				speakState.enabled = true;
				persistState();
				setPhase("ready", ctx);
				ctx.ui.notify(`Speech mode enabled (${describeTtsProvider(getSpeakRuntimeState())})`, "info");
				return;
			}

			if (lower === "stop" || lower === "interrupt" || lower === "quiet" || lower === "shush") {
				stopSpeaking(ctx);
				ctx.ui.notify(
					speakState.enabled ? "Stopped current speech playback" : "No speech playback is active",
					"info",
				);
				return;
			}

			if (lower === "off" || lower === "disable") {
				speakState.enabled = false;
				persistState();
				stopSpeaking(ctx);
				updateStatus(ctx);
				ctx.ui.notify("Speech mode disabled", "info");
				return;
			}

			if (lower === "status") {
				const rewriteStatus = isRewriteEnabled(getSpeakRuntimeState()) ? "rewrite on" : "rewrite off";
				ctx.ui.notify(
					speakState.enabled
						? `Speech mode is on (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus})`
						: `Speech mode is off (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus})`,
					"info",
				);
				return;
			}

			if (lower === "providers") {
				ctx.ui.notify(`Available providers: ${AVAILABLE_TTS_PROVIDERS.join(", ")}`, "info");
				return;
			}

			if (lower.startsWith("provider ")) {
				const requested = lower.slice("provider ".length).trim() as TtsProvider;
				if (!AVAILABLE_TTS_PROVIDERS.includes(requested)) {
					ctx.ui.notify(`Unknown provider "${requested}". Use /speak providers`, "error");
					return;
				}
				speakState.provider = requested;
				persistState();
				stopSpeaking(ctx);
				updateStatus(ctx);
				ctx.ui.notify(`Speech provider set to ${describeTtsProvider(getSpeakRuntimeState())}`, "info");
				return;
			}

			if (lower === "rewrite on" || lower === "rewrite enable") {
				speakState.rewriteEnabled = true;
				persistState();
				ctx.ui.notify("Speech rewrite enabled", "info");
				return;
			}

			if (lower === "rewrite off" || lower === "rewrite disable") {
				speakState.rewriteEnabled = false;
				persistState();
				ctx.ui.notify("Speech rewrite disabled", "info");
				return;
			}

			if (lower === "test") {
				speakState.enabled = true;
				persistState();
				setPhase("ready", ctx);
				void speakText(`Hey, this is Pi speak using ${describeTtsProvider(getSpeakRuntimeState())}.`, ctx);
				ctx.ui.notify(`Played speech test with ${describeTtsProvider(getSpeakRuntimeState())}`, "info");
				return;
			}

			speakState.enabled = true;
			persistState();
			setPhase("ready", ctx);
			ctx.ui.notify(`Speech mode enabled (${describeTtsProvider(getSpeakRuntimeState())})`, "info");
			pi.sendUserMessage(raw);
		},
	});

	const hardStopPkSpeak = (ctx: any) => {
		speakState.enabled = false;
		persistState();
		disableOmpSpeechConfig();
		stopSpeaking(ctx);
		stopListener(ctx);
		persistMonoState();
		updateStatus(ctx);
		updateMonoStatus(ctx);
	};

	pi.registerCommand("pk-speak", {
		description: "Hard-stop pk-speak voice replies and the wake listener",
		getArgumentCompletions: (prefix) => {
			const options = ["stop", "off", "on", "status", "quiet", "silence", "shush"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();

			if (!lower || lower === "stop" || lower === "off" || lower === "quiet" || lower === "silence" || lower === "shush") {
				hardStopPkSpeak(ctx);
				ctx.ui.notify("pk-speak stopped: speech disabled and wake listener stopped", "info");
				return;
			}

			if (lower === "on" || lower === "enable" || lower === "start") {
				clearRootVoiceDisable();
				enableOmpSpeechConfig();
				speakState.enabled = true;
				persistState();
				setPhase("ready", ctx);
				updateStatus(ctx);
				ctx.ui.notify(`pk-speak enabled (${describeTtsProvider(getSpeakRuntimeState())})`, "info");
				return;
			}

			if (lower === "status") {
				const rewriteStatus = isRewriteEnabled(getSpeakRuntimeState()) ? "rewrite on" : "rewrite off";
				const monoStatus = monoActive
					? voiceInputActive
						? "listener active"
						: "listener waiting for wake"
					: "listener off";
				ctx.ui.notify(
					`pk-speak: speech ${speakState.enabled ? "on" : "off"} (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus}); ${monoStatus}`,
					"info",
				);
				return;
			}

			ctx.ui.notify("Usage: /pk-speak [stop|off|on|status]", "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const remoteRuntime = remoteServer?.getRuntimeState();
		speakState = {
			enabled: false,
			provider: "auto",
		};
		remoteState = {
			enabled: !!remoteRuntime?.enabled,
			host: remoteRuntime?.host || DEFAULT_REMOTE_HOST,
			port: remoteRuntime?.port || DEFAULT_REMOTE_PORT,
			authToken: process.env.PI_SPEAK_HTTP_TOKEN || DEFAULT_REMOTE_AUTH_TOKEN,
		};
		lastAssistantText = "";
		phase = "ready";
		const persistedRouting = loadPersistedSessionRouting();
		sessionRegistry = { ...persistedRouting.sessions };
		sessionWakeAliases = { ...persistedRouting.aliases };
		lastRoutingStoreMtime = readRoutingStoreMtime();
		startRoutingStoreWatcher();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data && typeof entry.data === "object") {
				const savedSpeakState = entry.data as SpeakState;
				speakState = {
					...speakState,
					...savedSpeakState,
					enabled: !!savedSpeakState.enabled,
				};
			}
			if (entry.type === "custom" && entry.customType === MONO_STATE_TYPE && entry.data && typeof entry.data === "object") {
				const mono = entry.data as MonoState;
				if (mono.listening && !monoActive) {
					startListener(ctx);
				}
			}
			if (entry.type === "custom" && entry.customType === PHONE_STATE_TYPE && entry.data && typeof entry.data === "object") {
				phoneState = { ...phoneState, ...(entry.data as PhoneBridgeState) };
			}
			if (entry.type === "custom" && entry.customType === REMOTE_STATE_TYPE && entry.data && typeof entry.data === "object") {
				remoteState = { ...remoteState, ...(entry.data as RemoteState) };
				remoteState.authToken = process.env.PI_SPEAK_HTTP_TOKEN || DEFAULT_REMOTE_AUTH_TOKEN;
				remoteDefaultTarget = remoteState.defaultTarget;
			}
			if (entry.type === "custom" && entry.customType === SESSION_REGISTRY_TYPE && entry.data && typeof entry.data === "object") {
				const reg = entry.data as SessionRegistryState;
				if (reg.sessions) {
					sessionRegistry = { ...sessionRegistry, ...reg.sessions };
				}
			}
			if (entry.type === "custom" && entry.customType === SESSION_WAKE_ALIAS_TYPE && entry.data && typeof entry.data === "object") {
				const aliasState = entry.data as SessionWakeAliasState;
				if (aliasState.aliases) {
					sessionWakeAliases = { ...sessionWakeAliases, ...aliasState.aliases };
				}
			}
		}
		// Register current session in registry if it has a name
		const currentName = pi.getSessionName();
		const currentFile = ctx.sessionManager.getSessionFile();
		if (currentName && currentFile) {
			const named = setNamedSession(sessionRegistry, currentName, currentFile);
			if (named.ok) {
				sessionRegistry = named.sessions;
				persistSessionRoutingState();
			}
		}

		if (phoneBridge) {
			const status = phoneBridge.getStatus();
			phoneState = {
				...phoneState,
				enabled: true,
				linkedChatId: status.linkedChatId,
				linkCode: status.linkCode,
				lastUpdateId: status.lastUpdateId,
				lastPollAt: status.lastPollAt,
				consecutivePollFailures: status.consecutivePollFailures,
				lastError: status.lastError,
			};
		} else if (phoneState.enabled) {
			await startPhoneBridge(ctx, true);
		}

		if (remoteServer) {
			const runtime = remoteServer.getRuntimeState();
			syncRemoteState(
				{
					enabled: true,
					host: runtime.host,
					port: runtime.port,
					authToken: runtime.authToken,
				},
				false,
			);
		} else if (remoteState.enabled) {
			await startRemoteServer(ctx, true);
		}

		updateStatus(ctx);
		updateMonoStatus(ctx);
		updatePhoneStatus(ctx);
		updateRemoteStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastCtx = ctx;
		if (Object.keys(sessionRegistry).length > 0) {
			persistSessionRegistry();
		}
		if (Object.keys(sessionWakeAliases).length > 0) {
			persistSessionWakeAliases();
		}
		stopRoutingStoreWatcher();
		rejectPendingPhoneTurn("Session changed before the phone reply was delivered");
		remoteTurnManager.cancelAll("Session changed before queued remote work completed");
		stopRemoteTray();
		stopSpeaking(ctx);
		await codexAgentProvider.stop().catch(() => {});
		await shutdownLocalSttWorker().catch(() => {});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		const shouldInjectSpeechPrompt = speakState.enabled || forceSpeechPromptNextTurn;
		forceSpeechPromptNextTurn = false;
		if (!shouldInjectSpeechPrompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SPEECH_MODE_PROMPT}`,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		lastAssistantText = "";
		if (speakState.enabled) setPhase("llm", ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		lastCtx = ctx;
		if (!event.message || event.message.role !== "assistant") return;
		piAgentProvider.handleMessageUpdate(event as { assistantMessageEvent?: { type?: string; delta?: string; text?: string } });
	});

	pi.on("message_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!event.message || event.message.role !== "assistant") return;
		const text = extractText(event.message.content);
		if (text) lastAssistantText = text;
		piAgentProvider.handleMessageEnd(text);
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		piAgentProvider.handleAgentEnd();
		const replyText = lastAssistantText.trim();
		if (speakState.enabled && ctx.hasUI) {
			if (replyText) {
				void speakText(replyText, ctx);
			} else {
				setPhase("ready", ctx);
			}
		}
		if (pendingRemoteTurn) {
			await resolvePendingPhoneTurn(ctx);
		}
	});

	// Voice tool-use approval. Off by default for backwards compatibility.
	// PI_SPEAK_VOICE_APPROVAL=writes  → gate bash/write/edit
	// PI_SPEAK_VOICE_APPROVAL=all     → gate every tool call (very chatty)
	// Gating is also skipped when the voice listener isn't running, since
	// there's no way for the operator to answer.
	pi.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		const policy = (process.env.PI_SPEAK_VOICE_APPROVAL || "off").trim().toLowerCase();
		if (policy === "off") return undefined;
		if (!listenerProcess) return undefined;
		const gated =
			policy === "all" ||
			(policy === "writes" && (event.toolName === "bash" || event.toolName === "write" || event.toolName === "edit"));
		if (!gated) return undefined;
		const description = describeToolCallForVoice(event);
		notifyAudible(ctx, `Tool approval: ${description}`, "warning", `Approve ${description}. Say yes or no.`);
		const decision = await approvalRegistry.request({
			description,
			spokenPrompt: `Approve ${description}. Say yes or no.`,
			timeoutMs: 30_000,
		});
		if (decision === "accept") return undefined;
		notifyAudible(ctx, `Tool denied by voice: ${description}`, "info", `Denied.`);
		return { block: true, reason: "Denied by voice approval" };
	});
}

function describeToolCallForVoice(event: { toolName: string; input?: any }): string {
	const input = (event.input || {}) as Record<string, unknown>;
	const truncate = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max)}…` : value);
	switch (event.toolName) {
		case "bash":
			return `bash: ${truncate(typeof input.command === "string" ? input.command : "(no command)")}`;
		case "write":
			return `write: ${truncate(typeof input.path === "string" ? input.path : "(no path)")}`;
		case "edit":
			return `edit: ${truncate(typeof input.path === "string" ? input.path : "(no path)")}`;
		default:
			return `${event.toolName}`;
	}
}

function describeCodexApprovalForVoice(request: { method: string; params: Record<string, unknown> }): string {
	const truncate = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max)}…` : value);
	const reason = typeof request.params.reason === "string" ? request.params.reason : "";
	switch (request.method) {
		case "item/commandExecution/requestApproval": {
			const command = typeof request.params.command === "string" ? request.params.command : "(unknown command)";
			return `bash: ${truncate(command)}`;
		}
		case "item/fileChange/requestApproval":
			return reason ? `file change: ${truncate(reason)}` : "file change";
		case "item/permissions/requestApproval":
			return reason ? `permissions: ${truncate(reason)}` : "permissions request";
		default:
			return request.method;
	}
}
