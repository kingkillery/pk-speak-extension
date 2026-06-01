#!/usr/bin/env node
import { ControlServer, type ControlActionResult, type ControlServerStatus } from "./control-server.js";
import { collectAgentResponse, resolveAgentProviderConfig, type AgentProvider } from "./agent-provider.js";
import { CodexAgentProvider } from "./codex-agent-provider.js";
import { isGeminiLiveConfigured, runGeminiLiveTurn, runGeminiTextTurn } from "./gemini-live-turn.js";
import type { RemoteTurnResult, TurnProgressEvent } from "./remote-turn-manager.js";
import { shutdownLocalSttWorker, transcribeAudioBuffer } from "./stt.js";
import { getAudioMimeType, synthesizeToFile, type TtsProvider } from "./tts.js";
import { discoverAgentInventoryCached, discoverOpenAgentTargets, resolveWindowsNpmShim, resolveWindowsPiNodeCommand } from "./agent-discovery.js";
import type { SessionDashboard, SessionDashboardEntry } from "./session-routing.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
	PI_BIN: process.env.PI_BIN || resolveWindowsNpmShim("pi.cmd") || "pi",
});
let provider: AgentProvider;
let fallbackProvider: AgentProvider | undefined;

function createAgentProvider(): AgentProvider {
	if (agentConfig.provider === "elevenlabs") {
		return createCodingAgentProvider();
	}
	if (agentConfig.provider === "gemini" || agentConfig.provider === "gemini-live") {
		return new GeminiProvider(agentConfig.provider);
	}
	if (agentConfig.provider === "pi") {
		return new PiCliProvider(agentConfig.piBin, process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd());
	}
	return createCodexProvider();
}

function createCodingAgentProvider(): AgentProvider {
	const backend = (process.env.PI_SPEAK_AGENT_BACKEND || process.env.PI_SPEAK_CODING_AGENT || "codex").trim().toLowerCase();
	if (backend === "pi") {
		return new PiCliProvider(agentConfig.piBin, process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd());
	}
	return createCodexProvider();
}

function createCodexProvider(): AgentProvider {
	fallbackProvider = new PiCliProvider(agentConfig.piBin, process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd());
	return new CodexAgentProvider({
		codexBin: agentConfig.codexBin,
		cwd: process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd(),
		model: agentConfig.model,
		approvalPolicy: agentConfig.approvalPolicy,
		sandbox: agentConfig.sandbox,
		env: process.env,
	});
}

const routing = {
	currentSession: undefined as string | undefined,
	defaultTarget: undefined as string | undefined,
	availableTargets: [] as string[],
};

function refreshRoutingTargets() {
	const discovered = discoverOpenAgentTargets();
	const explicit = routing.defaultTarget ? [routing.defaultTarget] : [];
	routing.availableTargets = [...new Set([...explicit, ...discovered])].sort((left, right) => left.localeCompare(right));
	routing.currentSession = routing.defaultTarget || routing.availableTargets[0] || undefined;
}

function status(): ControlServerStatus {
	refreshRoutingTargets();
	return {
		agent: {
			provider: provider.name,
			configuredProvider: agentConfig.provider,
			model: agentConfig.model,
			capabilities: {
				textTurns: true,
				voiceTurns: true,
				audioReplies: true,
				routing: true,
				steering: provider.name === "codex",
			},
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

async function runTextTurn(text: string, includeAudio = false, cwd?: string, transcript?: string): Promise<RemoteTurnResult> {
	const prompt = text.trim();
	if (!prompt) return { replyText: "Send a message first." };
	if (agentConfig.provider === "elevenlabs") {
		const result = await runCodingAgentTurn(prompt, includeAudio, cwd, transcript, "elevenlabs");
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
	return runCodingAgentTurn(prompt, includeAudio, cwd, transcript);
}

async function runCodingAgentTurn(
	prompt: string,
	includeAudio = false,
	cwd?: string,
	transcript?: string,
	audioProvider?: TtsProvider,
	progress: TurnProgressEvent[] = [],
): Promise<RemoteTurnResult> {
	const options = {
		model: agentConfig.model,
		cwd: cwd || process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd(),
	};
	const startedAt = Date.now();
	addProgress(progress, "agent", `Sending request to ${provider.name} in ${options.cwd}.`, startedAt);
	let activeProvider = provider;
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

async function runVoiceTurn(buffer: Buffer, mimeType?: string, includeAudio = false, cwd?: string): Promise<RemoteTurnResult> {
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
	const result = await runTextTurnWithProgress(transcript, includeAudio, cwd, transcript, progress);
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
	const sessions: SessionDashboardEntry[] = inventory.recent.map((session) => ({
		name: session.title || session.cwdBasename || session.sessionId || session.path,
		path: session.path,
		sessionPath: session.path,
		workingDirectory: session.cwd,
		cwd: session.cwd,
		current: false,
		isCurrent: false,
		ready: false,
		isReady: false,
		activity: "saved",
		aliases: [],
	}));
	return {
		current: "none",
		ready: [],
		storePath: "recent CLI sessions",
		sessions,
	};
}

class PiCliProvider implements AgentProvider {
	readonly name = "pi" as const;
	constructor(private readonly piBin: string, private readonly cwd: string) {}

	async *sendPrompt(prompt: string, options: { cwd?: string } = {}) {
		const command = resolveWindowsPiNodeCommand(this.piBin) || { file: this.piBin, args: [] };
		const text = await runCli(command.file, [...command.args, "-p", "--no-tools", "--no-context-files", "--no-skills", "--no-extensions", "--no-session", prompt], {
			cwd: options.cwd || this.cwd,
			name: "pi",
			shell: command.shell,
		});
		if (text) yield { type: "text" as const, text };
	}
}

class CodexExecProvider implements AgentProvider {
	readonly name = "codex" as const;
	constructor(private readonly codexBin: string, private readonly cwd: string, private readonly model?: string) {}

	async *sendPrompt(prompt: string, options: { cwd?: string; model?: string } = {}) {
		const cwd = options.cwd || this.cwd;
		const args = ["exec", "--skip-git-repo-check", "-C", cwd, "--color", "never"];
		const model = options.model || this.model;
		if (model) args.push("-m", model);
		args.push("-");
		const text = await runCli(this.codexBin, args, { cwd, name: "codex exec", stdin: prompt });
		if (text) yield { type: "text" as const, text };
	}
}

class GeminiProvider implements AgentProvider {
	readonly name: "gemini" | "gemini-live" | "elevenlabs";
	constructor(name: "gemini" | "gemini-live" | "elevenlabs") {
		this.name = name;
	}

	async *sendPrompt(prompt: string) {
		const result = this.name === "gemini-live"
			? await runGeminiLiveTurn(prompt)
			: await runGeminiTextTurn(prompt);
		if (result.replyText) yield { type: "text" as const, text: result.replyText };
	}
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
	onTextTurn: async (text, includeAudio, _target, cwd, _mode) => runTextTurn(text, includeAudio, cwd),
	onVoiceTurn: async (buffer, mimeType, includeAudio, _target, cwd, _mode) => runVoiceTurn(buffer, mimeType, includeAudio, cwd),
	onTurnCancel: cancelCurrentTurn,
	getSessionDashboard: buildRecentSessionDashboard,
	getCompactRouteSlots: () => [],
	getDiscoveredAgents: () => discoverAgentInventoryCached(),
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

function buildAgentEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (!env.OPENAI_API_KEY && env.PI_SPEAK_OPENAI_KEY) {
		env.OPENAI_API_KEY = env.PI_SPEAK_OPENAI_KEY;
	}
	return env;
}

function runCli(command: string, args: string[], options: { cwd: string; name: string; stdin?: string; shell?: boolean }): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: buildAgentEnv(),
			windowsHide: true,
			shell: options.shell ?? (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)),
			stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeoutMs = Number.parseInt(process.env.AGENT_TURN_TIMEOUT_MS || "45000", 10);
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			killProcessTree(child.pid);
			reject(new Error(`${options.name} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		if (!child.stdout || !child.stderr) {
			clearTimeout(timeout);
			reject(new Error(`${options.name} did not expose output streams`));
			return;
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(new Error(stderr.trim() || `${options.name} exited with code ${code ?? "unknown"}`));
		});
		if (options.stdin && child.stdin) {
			child.stdin.end(options.stdin);
		}
	});
}

function killProcessTree(pid?: number) {
	if (!pid) return;
	if (process.platform === "win32") {
		spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
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
