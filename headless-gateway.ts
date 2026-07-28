#!/usr/bin/env node
import { ControlServer, type ControlActionResult, type ControlServerStatus, type RemoteSlashCommand, type SessionResumePayload } from "./control-server.js";
import { applyPiSpeakSetupConfig, loadPiSpeakSetupConfig, resolveTelegramBotToken, savePiSpeakSetupConfig } from "./setup-config.js";
import { TelegramPhoneBridge, type PhoneBridgeState } from "./phone-bridge.js";
import { collectAgentResponse, resolveAgentProviderConfig, type AgentProvider } from "./agent-provider.js";
import { createInitialAgentProviders, createOmpResumeProvider, createTurnAgentProvider } from "./agent-provider-factory.js";
import {
	buildAgentResumeArgs,
	buildAgentResumeCommandPreview,
	getAgentProviderCapabilities,
	isResumableAgentSession,
} from "./agent-provider-registry.js";
import { planConversationExecution, type ExecutionBackend } from "./conversation-execution-router.js";
import { reduceConversationTurn } from "./conversation-reducer.js";
import {
	buildResumeRouteTarget,
	normalizeGatewayProviderOverride,
	resolveRequestedRouteTarget,
	type GatewayProviderOverride,
	type ResumedGatewayTarget,
} from "./headless-gateway-routing.js";
import { runGeminiLiveTurn, runGeminiTextTurn } from "./gemini-live-turn.js";
import { RemoteTurnManager, type RemoteTurnResult, type TurnProgressEvent } from "./remote-turn-manager.js";
import { getSttDiagnostics, shutdownLocalSttWorker, transcribeAudioBuffer, transcribeWithWhisperX } from "./stt.js";
import { getAudioMimeType, synthesizeToFile, type TtsProvider } from "./tts.js";
import { discoverAgentInventoryCached, discoverOpenAgentTargets, resolveWindowsNpmShim } from "./agent-discovery.js";
import { archiveOhMyPiBackgroundSession, buildColabLaunchPlan, buildOhMyPiLaunchArgv, recoverOhMyPiBackgroundSession, validateOmpSelection } from "./agent-hub-actions.js";
import { buildOhMyPiAgentHubDashboardCached, defaultOhMyPiSessionRoots, mergeOhMyPiAgentHubSessionsCached } from "./agent-hub-dashboard.js";
import { createLiveAgentHubBinding } from "./herdr-agent-hub-live.js";
import { handleRealtimeGateway } from "./realtime-gateway.js";
import { enrichDashboardWithWorkspaces, normalizeArchivePath, type SessionDashboard, type SessionDashboardEntry } from "./session-routing.js";
import { loadPersistedSessionRouting, persistSessionRouting } from "./session-routing-store.js";
import { OmpSelectionStore } from "./omp-selection.js";
import { spawnDetached } from "./spawn-shim.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath, sep as pathSep } from "node:path";
import { homedir, tmpdir } from "node:os";

applyPiSpeakSetupConfig();

const state = {
	enabled: true,
	host: process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0",
	port: Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10),
	authToken: process.env.PI_SPEAK_HTTP_TOKEN || "",
	role: "gateway" as const,
};

// The headless gateway is the long-lived remote surface used by ompk and the
// Agent Hub. Keep its Telegram pairing state outside of a short-lived Pi TUI
// session so a bot never silently polls a different, inactive runtime.
let phoneState: PhoneBridgeState = {
	...loadPiSpeakSetupConfig().phoneState,
	enabled: false,
};
let phoneBridge: TelegramPhoneBridge | undefined;

function getTelegramBotToken() {
	return resolveTelegramBotToken();
}

function syncPhoneState(patch: Partial<PhoneBridgeState>, persist = false) {
	phoneState = { ...phoneState, ...patch };
	if (!persist) return;
	const { botToken: _ignoredBotToken, ...persistedPhoneState } = phoneState;
	const config = loadPiSpeakSetupConfig();
	savePiSpeakSetupConfig({ ...config, phoneState: persistedPhoneState });
}

function getPhoneStatus() {
	const runtime = phoneBridge?.getStatus();
	return {
		enabled: phoneState.enabled,
		linkedChatId: runtime?.linkedChatId || phoneState.linkedChatId,
		linkCode: runtime?.linkCode || phoneState.linkCode,
		lastPollAt: runtime?.lastPollAt || phoneState.lastPollAt,
		consecutivePollFailures: runtime?.consecutivePollFailures ?? phoneState.consecutivePollFailures ?? 0,
		lastError: runtime?.lastError || phoneState.lastError,
	};
}

function getPhoneStatusText() {
	const phone = getPhoneStatus();
	if (!getTelegramBotToken()) return "Telegram is not configured. Set a bot token with pk-speak phone token <bot-token>.";
	return [
		`Phone bridge ${phone.enabled ? "running" : "stopped"}.`,
		phone.linkedChatId ? "Phone is linked." : `Awaiting link code ${phone.linkCode || "unknown"}.`,
		phone.lastPollAt ? `Last Telegram poll: ${new Date(phone.lastPollAt).toLocaleTimeString()}.` : "Last Telegram poll: none.",
		phone.consecutivePollFailures ? `Telegram poll failures: ${phone.consecutivePollFailures}.` : "Telegram poll failures: 0.",
		phone.lastError ? `Last phone error: ${phone.lastError}.` : "",
	].filter(Boolean).join(" ");
}

async function startPhoneBridge() {
	const token = getTelegramBotToken();
	if (!token) return false;
	if (!phoneBridge) {
		phoneBridge = new TelegramPhoneBridge({
			token,
			state: phoneState,
			getStatusText: getPhoneStatusText,
			onStateChange: (patch) => {
				// Poll timestamps and update cursors change continuously. Persist only
				// durable pairing/security transitions, not each 25-second long poll.
				const persistentKeys: Array<keyof PhoneBridgeState> = [
					"enabled", "linkedChatId", "linkCode", "lastError", "linkAttempts", "linkLockoutUntil", "linkCodeIssuedAt",
				];
				const shouldPersist = persistentKeys.some((key) =>
					Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== phoneState[key],
				);
				syncPhoneState(patch, shouldPersist);
			},
			onTextTurn: (text) => remoteTurnManager.enqueue(
				"telegram-text",
				() => runTextTurn(text, true, undefined, undefined, undefined, undefined, undefined, "telegram"),
			),
			onVoiceBuffer: (buffer, mimeType) => remoteTurnManager.enqueue(
				"telegram-voice",
				() => runVoiceTurn(buffer, mimeType, true, undefined, undefined, undefined, undefined, "telegram"),
			),
		});
	}
	phoneBridge.start();
	const runtime = phoneBridge.getStatus();
	syncPhoneState({
		enabled: true,
		linkedChatId: runtime.linkedChatId,
		linkCode: runtime.linkCode,
		lastUpdateId: runtime.lastUpdateId,
	}, true);
	return true;
}

async function stopPhoneBridge() {
	if (phoneBridge) {
		await phoneBridge.stop().catch(() => {});
		phoneBridge = undefined;
	}
	syncPhoneState({ enabled: false }, true);
}

async function handlePhoneAction(action: "on" | "off" | "status" | "code" | "unpair"): Promise<ControlActionResult> {
	if (action === "on") {
		const started = await startPhoneBridge();
		return { ok: started, message: getPhoneStatusText(), phone: getPhoneStatus() };
	}
	if (action === "off") {
		await stopPhoneBridge();
		return { ok: true, message: "Phone bridge stopped.", phone: getPhoneStatus() };
	}
	if (action === "status") return { ok: true, message: getPhoneStatusText(), phone: getPhoneStatus() };
	if (action === "code") {
		const started = await startPhoneBridge();
		if (!started || !phoneBridge) return { ok: false, message: getPhoneStatusText(), phone: getPhoneStatus() };
		return { ok: true, message: `Send /link ${phoneBridge.getStatus().linkCode} to your Telegram bot to pair this phone.`, phone: getPhoneStatus() };
	}
	if (!phoneBridge) {
		syncPhoneState({ linkedChatId: undefined, linkCode: undefined }, true);
		return { ok: true, message: "Phone bridge is not running. Start it with /phone on to get a new link code.", phone: getPhoneStatus() };
	}
	const linkCode = phoneBridge.resetLink();
	syncPhoneState({ linkedChatId: undefined, linkCode }, true);
	return { ok: true, message: `Phone unpaired. New link code: ${linkCode}.`, phone: getPhoneStatus() };
}

const DEFAULT_WINDOWS_WORKSPACE = "C:\\Dev";

function getDefaultAgentCwd(): string {
	return process.env.AGENT_CWD?.trim()
		|| process.env.AGENT_WORKSPACE?.trim()
		|| (process.platform === "win32" ? DEFAULT_WINDOWS_WORKSPACE : process.cwd());
}

const HEADLESS_SLASH_COMMANDS: RemoteSlashCommand[] = [
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
];

const agentConfig = resolveAgentProviderConfig({
	...process.env,
	CODEX_BIN: process.env.CODEX_BIN || resolveWindowsNpmShim("codex.cmd") || "codex",
	CLAUDE_BIN: process.env.CLAUDE_BIN || resolveWindowsNpmShim("claude.cmd") || "claude",
	PI_BIN: process.env.PI_BIN || resolveWindowsNpmShim("pi.cmd") || "pi",
});
let provider: AgentProvider;
let fallbackProvider: AgentProvider | undefined;
const ompSelection = new OmpSelectionStore();
const resumedTargets = new Map<string, ResumedGatewayTarget>();

function createAgentProvider(): AgentProvider {
	const created = createInitialAgentProviders({
		config: agentConfig,
		env: process.env,
	});
	fallbackProvider = created.fallbackProvider;
	return created.provider;
}

const routing = {
	currentSession: undefined as string | undefined,
	defaultTarget: undefined as string | undefined,
	availableTargets: [] as string[],
};

function refreshRoutingTargets() {
	const discovered = discoverOpenAgentTargets();
	const explicit = routing.defaultTarget ? [routing.defaultTarget] : [];
	const resumed = [...resumedTargets.keys()];
	routing.availableTargets = [...new Set([...explicit, ...resumed, ...discovered])].sort((left, right) => left.localeCompare(right));
	routing.currentSession = routing.defaultTarget || routing.availableTargets[0] || undefined;
}

function status(): ControlServerStatus {
	refreshRoutingTargets();
	return {
		agent: {
			provider: provider.name,
			configuredProvider: agentConfig.provider,
			model: agentConfig.model,
			capabilities: { ...getAgentProviderCapabilities(provider.name), ...provider.capabilities },
		},
		speak: { enabled: false, configuredProvider: "auto", provider: "tray", rewriteEnabled: false, phase: "standby" },
		mono: { running: false, voiceInputActive: false, keepAliveSeconds: 0, status: "off" },
		phone: getPhoneStatus(),
		remote: {
			enabled: true,
			host: state.host,
			port: state.port,
			authRequired: !!state.authToken,
			defaultTarget: routing.defaultTarget,
			currentSession: routing.currentSession,
			availableTargets: routing.availableTargets,
		},
	};
}

type TurnRoute = {
	cwd: string;
	target?: ResumedGatewayTarget;
	providerName?: GatewayProviderOverride;
	providerOverride?: AgentProvider;
	stopProvider: boolean;
};

function resolveTurnRoute(target?: string, cwd?: string, agentProvider?: GatewayProviderOverride): TurnRoute {
	const resumed = resolveRequestedRouteTarget({
		requestedTarget: target,
		defaultTarget: routing.defaultTarget,
		resumedTargets,
	});
	const providerName = normalizeGatewayProviderOverride(agentProvider) || resumed?.provider;
	const workingDirectory = cwd || resumed?.cwd || getDefaultAgentCwd();
	if (!providerName) {
		return { cwd: workingDirectory, target: resumed, stopProvider: false };
	}
	const decision = createExecutionProviderDecision(providerName, workingDirectory, false, resumed);
	return {
		cwd: workingDirectory,
		target: resumed,
		providerName,
		providerOverride: decision.provider,
		stopProvider: decision.stopAfterTurn,
	};
}

function createExecutionProviderDecision(
	backend: GatewayProviderOverride,
	cwd: string,
	preferShared = false,
	target?: ResumedGatewayTarget,
): ReturnType<typeof createTurnAgentProvider> {
	return createTurnAgentProvider({
		config: agentConfig,
		env: process.env,
		backend,
		cwd,
		target,
		preferShared,
		sharedProvider: provider,
		fallbackProvider,
		// ompk resume selection is handled per-client upstream in runTextTurn/runVoiceTurn;
		// the route path only runs when no selection short-circuited, so none here.
		ompSessionPath: undefined,
	});
}

type SkillIndexEntry = {
	name: string;
	summary: string;
	source?: string;
	path?: string;
};

function readSkillIndexEntries(): SkillIndexEntry[] {
	let raw = "";
	try {
		raw = readFileSync(join(homedir(), ".codex", "skill-index.md"), "utf8");
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

function handleHeadlessSlashCommand(
	trimmed: string,
	options: { model?: string; cwd?: string; agentProvider?: GatewayProviderOverride },
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
				`Gateway default model: ${agentConfig.model || "not set"}.`,
				`Provider: ${options.agentProvider || agentConfig.provider}.`,
				`Working directory: ${options.cwd || getDefaultAgentCwd()}.`,
			].join("\n"),
		};
	}
	return undefined;
}

async function runWithTurnRoute(
	prompt: string,
	includeAudio: boolean,
	route: TurnRoute,
	transcript?: string,
	audioProvider?: TtsProvider,
	progress: TurnProgressEvent[] = [],
	model?: string,
): Promise<RemoteTurnResult> {
	try {
		if (route.target) {
			addProgress(progress, "route", `Using target ${route.target.target} in ${route.cwd}.`);
		}
		if (route.providerName) {
			addProgress(progress, "route", `Using ${route.providerName} provider for this turn.`);
		}
		return await runCodingAgentTurn(prompt, includeAudio, route.cwd, transcript, audioProvider, progress, route.providerOverride, undefined, model);
	} finally {
		if (route.stopProvider) {
			await Promise.resolve(route.providerOverride?.stop?.()).catch(() => {});
		}
	}
}

async function runTextTurn(
	text: string,
	includeAudio = false,
	cwd?: string,
	transcript?: string,
	target?: string,
	agentProvider?: GatewayProviderOverride,
	model?: string,
	clientKey?: string,
): Promise<RemoteTurnResult> {
	const prompt = text.trim();
	if (!prompt) return { replyText: "Send a message first." };
	const localSlashResult = handleHeadlessSlashCommand(prompt, { model, cwd, agentProvider });
	if (localSlashResult) return localSlashResult;
	// Per-client ompk resume selection. An explicit non-ompk agentProvider/target on
	// this turn overrides the sticky selection (one-off to another backend).
	const selectedOmp = ompSelection.get(clientKey);
	const explicitOverride = (agentProvider && agentProvider !== "oh-my-pk") || !!target;
	if (selectedOmp && !explicitOverride) {
		const workingDirectory = cwd || getDefaultAgentCwd();
		const resumeProvider = createOmpResumeProvider(agentConfig.ompBin, workingDirectory, selectedOmp, process.env);
		return runCodingAgentTurn(
			prompt,
			includeAudio,
			workingDirectory,
			transcript,
			agentConfig.provider === "elevenlabs" ? "elevenlabs" : undefined,
			[],
			resumeProvider,
			() => { ompSelection.select(clientKey, null); },
			model,
		);
	}
	const route = resolveTurnRoute(target, cwd, agentProvider);
	if (route.providerOverride) {
		return runWithTurnRoute(
			prompt,
			includeAudio,
			route,
			transcript,
			agentConfig.provider === "elevenlabs" ? "elevenlabs" : undefined,
			[],
			model,
		);
	}
	if (agentConfig.provider === "elevenlabs") {
		const result = await runCodingAgentTurn(prompt, includeAudio, route.cwd, transcript, "elevenlabs", [], undefined, undefined, model);
		return result;
	}
	if (agentConfig.provider === "gemini-live") {
		if (!includeAudio) return await runGeminiTextTurn(prompt, { model });
		const toolHandler: import("./gemini-live-turn.js").GeminiToolHandler = async (name, args) => {
			if (name === "run_coding_task") {
				const taskResult = await runCodingAgentTurn(
					String((args as { task?: unknown }).task ?? prompt),
					false,
					route.cwd,
					transcript,
					undefined,
					[],
					undefined,
					undefined,
					model,
				);
				return taskResult.replyText || "Task completed with no text output.";
			}
			return `Unknown tool: ${name}`;
		};
		return await runGeminiLiveTurn(prompt, { model, toolHandler });
	}
	if (agentConfig.provider === "gemini") {
		const result = await runGeminiTextTurn(prompt, { model });
		if (!includeAudio) return {
			...result,
			providers: { ...result.providers, agent: "gemini" },
		};
		const audio = await renderReplyAudio(result.replyText);
		return {
			...result,
			audioPath: audio.audioPath,
			audioMimeType: audio.audioMimeType,
			timings: { ...result.timings, ...audio.timings },
			providers: { ...result.providers, ...audio.providers },
			warnings: [...(result.warnings || []), ...(audio.warnings || [])],
		};
	}
	return runCodingAgentTurn(prompt, includeAudio, route.cwd, transcript, undefined, [], undefined, undefined, model);
}

async function runCodingAgentTurn(
	prompt: string,
	includeAudio = false,
	cwd?: string,
	transcript?: string,
	audioProvider?: TtsProvider,
	progress: TurnProgressEvent[] = [],
	providerOverride?: AgentProvider,
	onPrimaryFailure?: (error: unknown) => void,
	model?: string,
): Promise<RemoteTurnResult> {
	const options = {
		model: model || agentConfig.model,
		cwd: cwd || getDefaultAgentCwd(),
	};
	const startedAt = Date.now();
	const initialProvider = providerOverride || provider;
	addProgress(progress, "agent", `Sending request to ${initialProvider.name} in ${options.cwd}.`, startedAt);
	let activeProvider = initialProvider;
	let warnings: string[] | undefined;
	let replyText: string;
	try {
		replyText = await collectAgentResponse(activeProvider, prompt, options);
	} catch (error) {
		// When the caller owns failure handling (e.g. an explicit ompk resume
		// selection), surface the error to the user instead of silently answering
		// from an unrelated fallback backend (review H3).
		if (onPrimaryFailure) {
			onPrimaryFailure(error);
			const message = error instanceof Error ? error.message : String(error);
			addProgress(progress, "error", `${activeProvider.name} failed: ${message}`, startedAt);
			return {
				replyText: `The ${activeProvider.name} session failed: ${message}. I've cleared that session selection — try again or pick another session.`,
				transcript: transcript ?? prompt,
				providers: { agent: activeProvider.name },
				warnings: [`${activeProvider.name}-failed`],
				progress,
			};
		}
		if (!fallbackProvider) throw error;
		warnings = [`Primary ${activeProvider.name} backend failed; used ${fallbackProvider.name} fallback.`];
		addProgress(progress, "agent", warnings[0], startedAt);
		activeProvider = fallbackProvider;
		replyText = await collectAgentResponse(activeProvider, prompt, options);
	}
	addProgress(progress, "agent", `${activeProvider.name} returned a reply.`, startedAt);
	const result: RemoteTurnResult = {
		replyText: replyText || "The agent completed the turn without returning text.",
		transcript: transcript ?? prompt,
		providers: { agent: activeProvider.name },
		warnings,
		progress,
	};
	if (!includeAudio) return result;
	addProgress(progress, "tts", "Generating spoken reply audio.", startedAt);
	const audio = await renderReplyAudio(result.replyText, audioProvider);
	addProgress(progress, "complete", "Turn complete.", startedAt);
	return {
		...result,
		audioPath: audio.audioPath,
		audioMimeType: audio.audioMimeType,
		timings: {
			...result.timings,
			...audio.timings,
		},
		providers: {
			...result.providers,
			...audio.providers,
		},
		warnings: [...(result.warnings || []), ...(audio.warnings || [])],
		progress,
	};
}

async function runVoiceTurn(
	buffer: Buffer,
	mimeType?: string,
	includeAudio = false,
	cwd?: string,
	target?: string,
	agentProvider?: GatewayProviderOverride,
	model?: string,
	clientKey?: string,
): Promise<RemoteTurnResult> {
	const startedAt = Date.now();
	const progress: TurnProgressEvent[] = [];
	addProgress(progress, "upload", `Received ${Math.round(buffer.length / 1024)} KB voice clip.`, startedAt);
	addProgress(progress, "stt", "Transcribing voice input.", startedAt);
	let stt: Awaited<ReturnType<typeof transcribeAudioBuffer>>;
	try {
		stt = await transcribeAudioBuffer(buffer, mimeType);
	} catch (error) {
		const replyText = `I received your voice message, but transcription is temporarily unavailable: ${error instanceof Error ? error.message : String(error)}.`;
		const result: RemoteTurnResult = {
			replyText,
			transcript: "Voice message received.",
			providers: { stt: "unavailable" },
			warnings: ["stt-unavailable"],
			progress: [
				...progress,
				makeProgress("error", "Transcription failed.", startedAt),
			],
		};
		if (!includeAudio) return result;
		const audio = await renderReplyAudio(replyText, agentConfig.provider === "elevenlabs" ? "elevenlabs" : undefined);
		return {
			...result,
			audioPath: audio.audioPath,
			audioMimeType: audio.audioMimeType,
			timings: audio.timings,
			providers: { ...result.providers, ...audio.providers },
			warnings: [...(result.warnings || []), ...(audio.warnings || [])],
		};
	}
	const transcript = stt.text.trim();
	const sttWarnings = stt.fallback ? [`STT fallback: existing → Moonshine (${stt.fallback.code}).`] : [];
	addProgress(progress, "stt", stt.provider ? `Transcription finished with ${stt.provider}.` : "Transcription finished.", startedAt);
	if (!transcript) {
		return {
			replyText: "I did not hear enough speech to send a turn.",
			transcript: "",
			providers: { stt: stt.provider },
			warnings: ["empty-transcript", ...sttWarnings],
			progress: [
				...progress,
				makeProgress("complete", "No speech text was detected.", startedAt),
			],
		};
	}
	// Honor this client's ompk selection for voice too (parity with text), unless an
	// explicit non-ompk provider/target overrides it for this turn.
	const selectedOmp = ompSelection.get(clientKey);
	const explicitOverride = (agentProvider && agentProvider !== "oh-my-pk") || !!target;
	const result = selectedOmp && !explicitOverride
		? await runTextTurn(transcript, includeAudio, cwd, transcript, target, agentProvider, model, clientKey)
		: await runRoutedVoiceTextTurn(transcript, includeAudio, cwd, transcript, progress, target, agentProvider, model);
	return {
		...result,
		timings: {
			...result.timings,
			sttMs: stt.durationMs,
		},
		providers: {
			...result.providers,
			stt: stt.provider,
		},
		warnings: [...(result.warnings || []), ...sttWarnings],
		progress: result.progress || progress,
	};
}

async function runRoutedVoiceTextTurn(
	text: string,
	includeAudio = false,
	cwd?: string,
	transcript?: string,
	progress: TurnProgressEvent[] = [],
	target?: string,
	agentProvider?: GatewayProviderOverride,
	model?: string,
): Promise<RemoteTurnResult> {
	const route = resolveTurnRoute(target, cwd, agentProvider);

	// When using Gemini Live as the agent, skip the reducer entirely. Gemini handles
	// routing naturally via the run_coding_task function call.
	if (agentConfig.provider === "gemini-live" && includeAudio) {
		addProgress(progress, "route", "Voice route: Gemini Live with oh-my-pk tool.");
		const toolHandler: import("./gemini-live-turn.js").GeminiToolHandler = async (name, args) => {
			if (name === "run_coding_task") {
				const taskResult = await runCodingAgentTurn(
					String((args as { task?: unknown }).task ?? text),
					false,
					route.cwd,
					transcript,
					undefined,
					[],
					undefined,
					undefined,
					model,
				);
				return taskResult.replyText || "Task completed with no text output.";
			}
			return `Unknown tool: ${name}`;
		};
		const geminiResult = await runGeminiLiveTurn(text, { model, toolHandler });
		return {
			...geminiResult,
			transcript: transcript ?? geminiResult.transcript,
			progress: [...progress, ...(geminiResult.progress || [])],
		};
	}

	const reduction = await reduceConversationTurn(text, { source: "http-voice" });
	const plan = planConversationExecution(reduction.summary);
	addProgress(progress, "route", plan.userProgress || `Voice route: ${plan.routeClass || "fast"} via ${plan.backend}.`);
	if (!reduction.dispatch || !plan.dispatch || !isRunnableVoiceBackend(plan.backend)) {
		// Not a routable coding task — still let the agent respond conversationally.
		const fallback = await runCodingAgentTurn(text, includeAudio, route.cwd, transcript, undefined, progress, undefined, undefined, model);
		return {
			...fallback,
			reducer: reduction.summary,
			execution: plan,
			timings: { ...fallback.timings, reducerMs: reduction.reducerMs },
			progress: fallback.progress || progress,
		};
	}
	const backend = route.providerName || plan.backend;
	if (!isRunnableVoiceBackend(backend)) {
		return {
			replyText: plan.userAck || plan.rationale || "This voice turn needs a route I cannot run from the gateway.",
			transcript,
			reducer: reduction.summary,
			execution: plan,
			timings: { reducerMs: reduction.reducerMs },
			progress: [
				...progress,
				makeProgress("complete", "Voice turn stopped before agent dispatch."),
			],
		};
	}
	const voiceRoute = route.providerOverride
		? route
		: (() => {
			const decision = createExecutionProviderDecision(backend, route.cwd, !route.target && !route.providerName, route.target);
			return {
				...route,
				providerName: backend,
				providerOverride: decision.provider,
				stopProvider: decision.stopAfterTurn,
			};
		})();
	const result = await runWithTurnRoute(
		reduction.promptForAgent,
		includeAudio,
		voiceRoute,
		transcript,
		undefined,
		progress,
		model,
	);
	return {
		...result,
		reducer: reduction.summary,
		execution: plan,
		timings: {
			...result.timings,
			reducerMs: reduction.reducerMs,
		},
		progress: result.progress || progress,
	};
}

function isRunnableVoiceBackend(backend: ExecutionBackend | GatewayProviderOverride): backend is GatewayProviderOverride {
	return backend === "pi" || backend === "codex" || backend === "claude" || backend === "oh-my-pk";
}

async function runTextTurnWithProgress(
	text: string,
	includeAudio = false,
	cwd?: string,
	transcript?: string,
	progress: TurnProgressEvent[] = [],
): Promise<RemoteTurnResult> {
	const prompt = text.trim();
	if (!prompt) return { replyText: "Send a message first.", progress };
	if (agentConfig.provider === "elevenlabs") {
		return await runCodingAgentTurn(prompt, includeAudio, cwd, transcript, "elevenlabs", progress);
	}
	return await runTextTurn(prompt, includeAudio, cwd, transcript);
}

async function cancelCurrentTurn(): Promise<ControlActionResult> {
	remoteTurnManager.cancelAll("Current turn cancelled.");
	await Promise.resolve(provider.stop?.()).catch(() => {});
	await Promise.resolve(fallbackProvider?.stop?.()).catch(() => {});
	fallbackProvider = undefined;
	provider = createAgentProvider();
	await Promise.resolve(provider.start?.());
	return ok("Current turn stopped and coding agent provider restarted.");
}

function makeProgress(phase: TurnProgressEvent["phase"], message: string, startedAt = Date.now()): TurnProgressEvent {
	const now = Date.now();
	return { ts: now, phase, message, elapsedMs: now - startedAt };
}

function addProgress(progress: TurnProgressEvent[], phase: TurnProgressEvent["phase"], message: string, startedAt = Date.now()) {
	progress.push(makeProgress(phase, message, startedAt));
}

async function renderReplyAudio(text: string, providerOverride?: TtsProvider): Promise<Partial<RemoteTurnResult>> {
	const trimmed = text.trim();
	if (!trimmed) return {};
	const audioDir = mkdtempSync(join(tmpdir(), "pi-speak-tray-reply-"));
	const outputPath = join(audioDir, "reply.mp3");
	const startedAt = Date.now();
	try {
		const synthesis = await synthesizeToFile({
			text: trimmed,
			outputPath,
			state: {
				enabled: true,
				provider: providerOverride || (process.env.PI_SPEAK_TTS_PROVIDER || "auto") as TtsProvider,
				rewriteEnabled: process.env.PI_SPEAK_REWRITE_ENABLED
					? !["0", "false", "off", "no"].includes(process.env.PI_SPEAK_REWRITE_ENABLED.toLowerCase())
					: true,
			},
		});
		return {
			audioPath: outputPath,
			audioMimeType: getAudioMimeType(outputPath),
			timings: { ttsMs: Date.now() - startedAt },
			providers: { tts: synthesis.provider },
		};
	} catch (error) {
		try {
			rmSync(audioDir, { recursive: true, force: true });
		} catch {}
		return {
			warnings: [`Audio synthesis failed: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

const ok = (message: string): ControlActionResult => ({ ok: true, message });
let server: ControlServer;

function buildRecentSessionDashboard(): SessionDashboard {
	const inventory = discoverAgentInventoryCached();
	const resumedByPath = new Map([...resumedTargets.values()].map((target) => [target.sessionPath.toLowerCase(), target]));
	const sessions: SessionDashboardEntry[] = inventory.recent.map((session) => {
		const displayName = session.title || session.cwdBasename || session.sessionId || session.path;
		const resumed = resumedByPath.get(session.path.toLowerCase());
		const name = resumed?.target || displayName;
		const current = !!resumed && routing.defaultTarget === resumed.target;
		return {
			name,
			path: session.path,
			sessionPath: session.path,
			provider: session.provider,
			sessionId: session.sessionId,
			resumable: isResumableAgentSession(session.provider, session.sessionId),
			resumeCommand: buildResumeCommandPreview(session.provider, session.sessionId, session.cwd),
			workingDirectory: session.cwd,
			cwd: session.cwd,
			current,
			isCurrent: current,
			ready: !!resumed,
			isReady: !!resumed,
			activity: resumed ? "idle" : "saved",
			aliases: resumed && displayName !== name ? [displayName] : [],
			lastActivity: session.updatedAt ? Date.parse(session.updatedAt) || undefined : undefined,
		};
	});
	const base: SessionDashboard = {
		current: routing.defaultTarget || "none",
		ready: [...resumedTargets.keys()],
		storePath: "recent CLI sessions",
		sessions,
	};
	// oh-my-pk background agents are the primary surface of the app; merge them in
	// (cached, stale-while-revalidate) so they appear over Tailscale, not just in
	// the in-terminal extension.
	const merged = mergeOhMyPiAgentHubSessionsCached(base);
	// Group by workspace, mark stale (>24h, not current), and hide archived paths.
	return enrichDashboardWithWorkspaces(merged, {
		archivedPaths: loadPersistedSessionRouting().archivedPaths,
	});
}

function resolveResumeExecutable(provider: string | undefined) {
	const normalized = provider?.trim().toLowerCase();
	if (normalized === "codex") return agentConfig.codexBin;
	if (normalized === "claude") return process.env.CLAUDE_BIN || resolveWindowsNpmShim("claude.cmd") || "claude";
	return undefined;
}

function buildResumeCommandPreview(provider: string | undefined, sessionId: string | undefined, cwd?: string) {
	const executable = resolveResumeExecutable(provider);
	return buildAgentResumeCommandPreview(provider, sessionId, executable, cwd);
}

function findDiscoveredResumeSession(payload: SessionResumePayload) {
	const inventory = discoverAgentInventoryCached(0);
	const requestedPath = payload.sessionPath?.trim().toLowerCase();
	const requestedId = payload.sessionId?.trim().toLowerCase();
	const requestedProvider = payload.provider?.trim().toLowerCase();
	return inventory.recent.find((session) => {
		const sessionId = session.sessionId;
		if (!isResumableAgentSession(session.provider, sessionId) || !sessionId) return false;
		if (requestedProvider && session.provider.toLowerCase() !== requestedProvider) return false;
		if (requestedPath && session.path.toLowerCase() !== requestedPath) return false;
		if (requestedId && sessionId.toLowerCase() !== requestedId) return false;
		return !!(requestedPath || requestedId);
	});
}

function resumeStoredSession(payload: SessionResumePayload): ControlActionResult {
	const session = findDiscoveredResumeSession(payload);
	if (!session) {
		return { ok: false, message: "Session was not found in the discovered resumable session stores." };
	}
	const executable = resolveResumeExecutable(session.provider);
	const args = buildAgentResumeArgs(session.provider, session.sessionId || "", session.cwd);
	if (!executable || !args) {
		return { ok: false, message: `Provider ${session.provider} does not support resume from this gateway.` };
	}
	const routeTarget = buildResumeRouteTarget({
		provider: session.provider,
		sessionId: session.sessionId,
		sessionPath: session.path,
		title: session.title,
		cwd: session.cwd || payload.cwd,
		cwdBasename: session.cwdBasename,
	});
	if (!routeTarget) {
		return { ok: false, message: `Provider ${session.provider} can be launched but cannot be routed by this gateway.` };
	}
	launchDetachedCli(executable, args, session.cwd || payload.cwd || getDefaultAgentCwd(), `${session.provider} resume`);
	resumedTargets.set(routeTarget.target, routeTarget);
	routing.defaultTarget = routeTarget.target;
	refreshRoutingTargets();
	return {
		ok: true,
		message: `Launching ${session.provider} resume for ${session.sessionId}. Route target: ${routeTarget.target}.`,
		provider: session.provider,
		sessionId: session.sessionId,
		sessionPath: session.path,
		cwd: session.cwd,
		target: routeTarget.target,
		command: [executable, ...args],
	};
}

function launchDetachedCli(command: string, args: string[], cwd: string, title: string) {
	if (process.platform === "win32") {
		const child = spawn("cmd.exe", ["/c", "start", title, "/D", cwd, command, ...args], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
		return;
	}
	const child = spawn(command, args, {
		cwd,
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

function resolveOhMyPiCommand(): string {
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

function isOhMyPiSessionPath(sessionPath: string): boolean {
	const resolved = resolvePath(sessionPath);
	return defaultOhMyPiSessionRoots().some((root) => {
		const resolvedRoot = resolvePath(root);
		return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + pathSep);
	});
}

function archiveOrRecoverSession(sessionPath: string, action: "archive" | "recover"): ControlActionResult {
	const trimmed = sessionPath?.trim();
	if (!trimmed) return { ok: false, message: "sessionPath is required." };

	// oh-my-pk lanes carry an in-file backgroundInstance.status; flip it in place.
	if (isOhMyPiSessionPath(trimmed)) {
		const result = action === "recover"
			? recoverOhMyPiBackgroundSession(trimmed)
			: archiveOhMyPiBackgroundSession(trimmed);
		return result;
	}

	// codex/claude: track-and-hide in the routing store (reversible, no file move).
	// Normalize so archive-with-spelling-A then recover-with-spelling-B still match,
	// and so the persisted set is canonical for the dashboard's archived check.
	const archiveKey = normalizeArchivePath(trimmed);
	const persisted = loadPersistedSessionRouting();
	const set = new Set(persisted.archivedPaths.map((p) => normalizeArchivePath(p)));
	if (action === "recover") {
		if (!set.delete(archiveKey)) return { ok: false, message: "Session is not archived." };
	} else {
		set.add(archiveKey);
	}
	persistSessionRouting({
		sessions: persisted.sessions,
		aliases: persisted.aliases,
		archivedPaths: [...set],
	});
	return {
		ok: true,
		message: action === "recover" ? "Recovered session." : "Archived session.",
	};
}

provider = createAgentProvider();

const remoteTurnManager = new RemoteTurnManager({});

server = new ControlServer({
	state,
	onStateChange: (patch) => Object.assign(state, patch),
	getStatus: status,
	getDiagnostics: () => ({
		...(refreshRoutingTargets(), {}),
		status: status(),
		lastErrors: {},
		recentTimings: {},
		queue: remoteTurnManager.getSnapshot(),
		providers: { stt: getSttDiagnostics() },
	}),
	getRoutingStatus: () => {
		refreshRoutingTargets();
		return { ...routing };
	},
	setRoutingTarget: (target) => {
		refreshRoutingTargets();
		const trimmed = target?.trim();
		if (trimmed && routing.availableTargets.length > 0 && !routing.availableTargets.includes(trimmed)) {
			return { ok: false, message: `Unknown target "${trimmed}". Detected: ${routing.availableTargets.join(", ") || "none"}.` };
		}
		routing.defaultTarget = trimmed || undefined;
		refreshRoutingTargets();
		return ok(routing.defaultTarget ? `Route target set to ${routing.defaultTarget}.` : "Route target cleared.");
	},
	onMonoAction: (action) => ok(`Mono ${action} is unavailable in tray gateway mode.`),
	onSpeakAction: (action) => ok(`Speak ${action} is unavailable in tray gateway mode.`),
	onPhoneAction: handlePhoneAction,
	getSlashCommands: () => HEADLESS_SLASH_COMMANDS,
	onTextTurn: async (text, includeAudio, target, cwd, _mode, agentProvider, model, clientKey) =>
		remoteTurnManager.enqueue("http-text", () => runTextTurn(text, includeAudio, cwd, undefined, target, agentProvider, model, clientKey)),
	onVoiceTurn: async (buffer, mimeType, includeAudio, target, cwd, _mode, agentProvider, model, clientKey) =>
		remoteTurnManager.enqueue("http-voice", () => runVoiceTurn(buffer, mimeType, includeAudio, cwd, target, agentProvider, model, clientKey)),
	onBrainstorm: async (buffer, mimeType, cwd) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-brainstorm-"));
		const extension = mimeType?.includes("webm") ? ".webm"
			: mimeType?.includes("ogg") ? ".ogg"
			: mimeType?.includes("wav") ? ".wav"
			: mimeType?.includes("mpeg") || mimeType?.includes("mp3") ? ".mp3"
			: mimeType?.includes("mp4") || mimeType?.includes("m4a") ? ".m4a"
			: ".bin";
		const filePath = join(tempDir, `input${extension}`);
		try {
			writeFileSync(filePath, buffer);
			
			// 1. Transcribe using WhisperX
			let text = "";
			try {
				text = await transcribeWithWhisperX(filePath);
			} catch (error) {
				console.warn("WhisperX transcription failed, falling back to standard local STT:", error);
				const fallbackRes = await transcribeAudioBuffer(buffer, mimeType);
				text = fallbackRes.text;
			}
			
			text = text.trim();
			if (!text) {
				return { ok: false, text: "", formatted: "No speech detected in the audio.", filePath: "" };
			}
			
			// 2. Prompt LLM to structure
			const prompt = `You are an expert research and prompt engineering assistant.
A user has recorded a brainstorm/word-vomit session. Your job is to analyze the text, organize the ideas, group them logically, extract key concepts, and structure it into a clean, professional, and highly usable prompt or research document.

Here is the raw transcribed brainstorm:
---
${text}
---

Provide the output in clean, formatted Markdown.`;

			const formatted = await collectAgentResponse(provider, prompt, {
				model: agentConfig.model,
				cwd: cwd || getDefaultAgentCwd(),
			});
			
			// 3. Save to disk in the current workspace directory under "brainstorming"
			const targetDir = join(cwd || getDefaultAgentCwd(), "brainstorming");
			if (!existsSync(targetDir)) {
				mkdirSync(targetDir, { recursive: true });
			}
			
			const now = new Date();
			const timestamp = now.toISOString().replace(/T/, "_").replace(/:/g, "-").slice(0, 19);
			const fileName = `brainstorm_${timestamp}.md`;
			const savePath = join(targetDir, fileName);
			
			const fileContent = `# Brainstorm Session - ${now.toLocaleString()}

## Structured Output
${formatted}

---
## Raw Transcript
${text}
`;
			
			writeFileSync(savePath, fileContent, "utf8");
			
			return {
				ok: true,
				text,
				formatted,
				filePath: savePath,
			};
		} finally {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		}
	},
	onTurnCancel: cancelCurrentTurn,
	getSessionDashboard: buildRecentSessionDashboard,
	getCompactRouteSlots: () => [],
	agentHub: createLiveAgentHubBinding({
		dashboardFn: () => buildOhMyPiAgentHubDashboardCached(),
		submitChatTurn: (text, target, cwd) =>
			remoteTurnManager.enqueue("http-text", () => runTextTurn(text, false, cwd, undefined, target)),
	}),
	onSessionResume: resumeStoredSession,
	onSessionArchive: (payload) =>
		archiveOrRecoverSession(payload.sessionPath ?? "", payload.action === "recover" ? "recover" : "archive"),
	onSessionLaunch: (payload) => {
		const fallbackCwd = payload.cwd?.trim()
			|| getDefaultAgentCwd();
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
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, message: `Session launch failed: ${message}` };
		}
	},
	getDiscoveredAgents: () => discoverAgentInventoryCached(),
	onRealtimeConnection: handleRealtimeGateway,
	onOmpSelectSession: (clientKey, sessionPath) => {
		const validation = validateOmpSelection(sessionPath);
		if (!validation.ok) return validation;
		ompSelection.select(clientKey, sessionPath);
		return { ok: true };
	},
	onOmpGetSelectedSession: (clientKey) => ompSelection.get(clientKey),
});

Promise.resolve(provider.start?.())
	.then(async () => {
		// A configured gateway owns the bot lifecycle. This is what makes a
		// Telegram link code target the same ompk/Agent Hub process as the app.
		if (getTelegramBotToken()) await startPhoneBridge();
	})
	.then(() => server.start())
	.then((runtime) => {
		console.log(`Pi Speak headless gateway listening on ${runtime.host}:${runtime.port} with ${provider.name}`);
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exit(1);
	});

// Once-per-day sweep: archive sessions stale 24h+ without use (never the current
// session). Reversible (omp in-file flip; codex/claude track-and-hide).
const AUTO_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
function runStaleSessionSweep() {
	try {
		const dashboard = buildRecentSessionDashboard();
		for (const entry of dashboard.sessions) {
			if (!entry.stale || entry.isCurrent || entry.archived) continue;
			const sessionPath = entry.sessionPath ?? entry.path;
			if (!sessionPath) continue;
			// Never archive a session a client currently has selected (review M3).
			if (ompSelection.isActive(sessionPath)) continue;
			archiveOrRecoverSession(sessionPath, "archive");
		}
	} catch (error) {
		console.error(`[auto-archive] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const autoArchiveTimer = setInterval(runStaleSessionSweep, AUTO_ARCHIVE_INTERVAL_MS);
autoArchiveTimer.unref?.();

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function shutdown() {
	Promise.resolve(stopPhoneBridge())
		.catch(() => {})
		.then(() => provider.stop?.())
		.catch(() => {})
		.then(() => shutdownLocalSttWorker())
		.catch(() => {})
		.then(() => server.stop())
		.catch(() => {})
		.finally(() => process.exit(0));
}

