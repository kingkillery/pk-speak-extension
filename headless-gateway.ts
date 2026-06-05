#!/usr/bin/env node
import { ControlServer, type ControlActionResult, type ControlServerStatus, type SessionResumePayload } from "./control-server.js";
import { applyPiSpeakSetupConfig } from "./setup-config.js";
import { collectAgentResponse, resolveAgentProviderConfig, type AgentProvider } from "./agent-provider.js";
import { createInitialAgentProviders, createTurnAgentProvider } from "./agent-provider-factory.js";
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
import type { RemoteTurnResult, TurnProgressEvent } from "./remote-turn-manager.js";
import { shutdownLocalSttWorker, transcribeAudioBuffer } from "./stt.js";
import { getAudioMimeType, synthesizeToFile, type TtsProvider } from "./tts.js";
import { discoverAgentInventoryCached, discoverOpenAgentTargets, resolveWindowsNpmShim } from "./agent-discovery.js";
import { handleRealtimeGateway } from "./realtime-gateway.js";
import type { SessionDashboard, SessionDashboardEntry } from "./session-routing.js";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

applyPiSpeakSetupConfig();

const state = {
	enabled: true,
	host: process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0",
	port: Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10),
	authToken: process.env.PI_SPEAK_HTTP_TOKEN || "",
};

const agentConfig = resolveAgentProviderConfig({
	...process.env,
	AGENT_PROVIDER: process.env.AGENT_PROVIDER || resolveDefaultAgentProvider(),
	CODEX_BIN: process.env.CODEX_BIN || resolveWindowsNpmShim("codex.cmd") || "codex",
	CLAUDE_BIN: process.env.CLAUDE_BIN || resolveWindowsNpmShim("claude.cmd") || "claude",
	PI_BIN: process.env.PI_BIN || resolveWindowsNpmShim("pi.cmd") || "pi",
});
let provider: AgentProvider;
let fallbackProvider: AgentProvider | undefined;
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
		phone: { enabled: false, consecutivePollFailures: 0 },
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
	const workingDirectory = cwd || resumed?.cwd || process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd();
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
	});
}

async function runWithTurnRoute(
	prompt: string,
	includeAudio: boolean,
	route: TurnRoute,
	transcript?: string,
	audioProvider?: TtsProvider,
	progress: TurnProgressEvent[] = [],
): Promise<RemoteTurnResult> {
	try {
		if (route.target) {
			addProgress(progress, "route", `Using target ${route.target.target} in ${route.cwd}.`);
		}
		if (route.providerName) {
			addProgress(progress, "route", `Using ${route.providerName} provider for this turn.`);
		}
		return await runCodingAgentTurn(prompt, includeAudio, route.cwd, transcript, audioProvider, progress, route.providerOverride);
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
): Promise<RemoteTurnResult> {
	const prompt = text.trim();
	if (!prompt) return { replyText: "Send a message first." };
	const route = resolveTurnRoute(target, cwd, agentProvider);
	if (route.providerOverride) {
		return runWithTurnRoute(
			prompt,
			includeAudio,
			route,
			transcript,
			agentConfig.provider === "elevenlabs" ? "elevenlabs" : undefined,
		);
	}
	if (agentConfig.provider === "elevenlabs") {
		const result = await runCodingAgentTurn(prompt, includeAudio, route.cwd, transcript, "elevenlabs");
		return result;
	}
	if (agentConfig.provider === "gemini-live") {
		return includeAudio ? await runGeminiLiveTurn(prompt) : await runGeminiTextTurn(prompt);
	}
	if (agentConfig.provider === "gemini") {
		const result = await runGeminiTextTurn(prompt);
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
	return runCodingAgentTurn(prompt, includeAudio, route.cwd, transcript);
}

async function runCodingAgentTurn(
	prompt: string,
	includeAudio = false,
	cwd?: string,
	transcript?: string,
	audioProvider?: TtsProvider,
	progress: TurnProgressEvent[] = [],
	providerOverride?: AgentProvider,
): Promise<RemoteTurnResult> {
	const options = {
		model: agentConfig.model,
		cwd: cwd || process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd(),
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
			providers: { stt: "local" },
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
	addProgress(progress, "stt", stt.provider ? `Transcription finished with ${stt.provider}.` : "Transcription finished.", startedAt);
	if (!transcript) {
		return {
			replyText: "I did not hear enough speech to send a turn.",
			transcript: "",
			providers: { stt: stt.provider },
			warnings: ["empty-transcript"],
			progress: [
				...progress,
				makeProgress("complete", "No speech text was detected.", startedAt),
			],
		};
	}
	const result = await runRoutedVoiceTextTurn(transcript, includeAudio, cwd, transcript, progress, target, agentProvider);
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
): Promise<RemoteTurnResult> {
	const route = resolveTurnRoute(target, cwd, agentProvider);
	const reduction = await reduceConversationTurn(text, { source: "http-voice" });
	const plan = planConversationExecution(reduction.summary);
	addProgress(progress, "route", plan.userProgress || `Voice route: ${plan.routeClass || "fast"} via ${plan.backend}.`);
	if (!reduction.dispatch || !plan.dispatch || !isRunnableVoiceBackend(plan.backend)) {
		return {
			replyText: reduction.replyText || plan.userAck || plan.rationale || "I need a concrete action before I can route this.",
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
	return backend === "pi" || backend === "codex" || backend === "claude";
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
		};
	});
	return {
		current: routing.defaultTarget || "none",
		ready: [...resumedTargets.keys()],
		storePath: "recent CLI sessions",
		sessions,
	};
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
		if (requestedPath && session.path.toLowerCase() === requestedPath) return true;
		if (requestedId && sessionId.toLowerCase() === requestedId) return true;
		return false;
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
	launchDetachedCli(executable, args, session.cwd || payload.cwd || process.cwd(), `${session.provider} resume`);
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

provider = createAgentProvider();

server = new ControlServer({
	state,
	onStateChange: (patch) => Object.assign(state, patch),
	getStatus: status,
	getDiagnostics: () => ({
		...(refreshRoutingTargets(), {}),
		status: status(),
		lastErrors: {},
		recentTimings: {},
		queue: { processing: false, queued: 0, maxQueued: 0, completedTurns: 0 },
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
	onPhoneAction: (action) => ok(`Phone ${action} is unavailable in tray gateway mode.`),
	onTextTurn: async (text, includeAudio, target, cwd, _mode, agentProvider) => runTextTurn(text, includeAudio, cwd, undefined, target, agentProvider),
	onVoiceTurn: async (buffer, mimeType, includeAudio, target, cwd, _mode, agentProvider) => runVoiceTurn(buffer, mimeType, includeAudio, cwd, target, agentProvider),
	onTurnCancel: cancelCurrentTurn,
	getSessionDashboard: buildRecentSessionDashboard,
	getCompactRouteSlots: () => [],
	onSessionResume: resumeStoredSession,
	getDiscoveredAgents: () => discoverAgentInventoryCached(),
	onRealtimeConnection: handleRealtimeGateway,
});

Promise.resolve(provider.start?.())
	.then(() => server.start())
	.then((runtime) => {
		console.log(`Pi Speak headless gateway listening on ${runtime.host}:${runtime.port} with ${provider.name}`);
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exit(1);
	});

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function shutdown() {
	Promise.resolve(provider.stop?.())
		.catch(() => {})
		.then(() => shutdownLocalSttWorker())
		.catch(() => {})
		.then(() => server.stop())
		.catch(() => {})
		.finally(() => process.exit(0));
}

function resolveDefaultAgentProvider(): "pi" | "codex" {
	if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return "codex";
	const codexBin = process.env.CODEX_BIN || resolveWindowsNpmShim("codex.cmd") || "codex";
	try {
		const output = execFileSync(codexBin, ["login", "status"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
			shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(codexBin),
			timeout: 5000,
		});
		return /logged in|authenticated/i.test(output) && !/not logged in/i.test(output) ? "codex" : "pi";
	} catch {
		return "pi";
	}
}
