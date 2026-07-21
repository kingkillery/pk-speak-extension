import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Behavior, FunctionResponseScheduling, GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";
import { createGeminiClient, getGeminiLiveModel } from "./gemini-live-turn.js";
import { readAttentionSnapshots, readAttentionLeaderLease } from "./attention-broker.js";
import { readSessionWorkingDirectory } from "./session-working-directory.js";
import { loadPersistedSessionRouting } from "./session-routing-store.js";
import { resolveWindowsNpmShim } from "./agent-discovery.js";
import { normalizeOptionalString } from "./agent-hub-actions.js";
import { safeSpawn } from "./spawn-shim.js";
import { resolve } from "node:path";
import type { RealtimeControlMessage } from "./realtime-types.js";
import {
	createRealtimeTerminalApprovalRegistry,
	type RealtimeTerminalApprovalRegistry,
} from "./realtime-terminal-approval.js";
import {
	buildRealtimeTerminalCommandPlan,
	classifyRealtimeTerminalCommand,
	executeRealtimeTerminalCommandPlan,
	looksLikeSecretPath,
	type RealtimeTerminalCommandPlan,
	type RealtimeTerminalCommandSafety,
} from "./realtime-terminal-command.js";
import {
	appendRealtimeTerminalAuditEvent,
	buildRealtimeTerminalAuditResult,
	buildRealtimeTerminalPlanAuditFields,
} from "./realtime-terminal-audit.js";
import {
	createRealtimeCommandApprovalRegistry,
	type RealtimeCommandApprovalRegistry,
	type RealtimeCommandKind,
} from "./realtime-command-approval.js";
import { listWorkspaceDirectory, readWorkspaceFile } from "./control-server.js";
import { reduceConversationTurn } from "./conversation-reducer.js";
import { parseHubAgentId } from "./herdr-agent-hub-schema.js";
import { shapeRealtimeToolOutputForSpeech } from "./realtime-speech-brief.js";
import { formatWebSearchForSpeech, isWebSearchConfigured, runWebSearch } from "./web-search.js";
import { resolveLiveBackendKind } from "./live-backend.js";
import type { LiveBackendSession } from "./live-backend.js";
import {
	connectOpenAiRealtimeLive,
	isOpenAiRealtimeLiveConfigured,
	resolveOpenAiRealtimeConnectUrl,
} from "./openai-realtime-live.js";
import {
	buildRealtimeSessionCandidates,
	resolveRealtimeSessionTarget,
	selectRealtimeCurrentTarget,
	type RealtimeSessionTargetCandidate,
	type RealtimeSessionTargetSources,
} from "./realtime-session-target.js";


// A live client's selected OMPK target is connection-local. The global
// attention lease is observation/fallback only, so concurrent voice clients
// cannot silently retarget one another.
function getCurrentCwd(activeSession?: { cwd?: string; selectedTarget?: RealtimeSessionTargetCandidate }): string {
	if (activeSession?.selectedTarget?.cwd) return activeSession.selectedTarget.cwd;
	if (activeSession?.cwd) return activeSession.cwd;
	const lease = readAttentionLeaderLease();
	if (lease?.ownerSessionId) {
		const activeSnapshot = readAttentionSnapshots().find((snapshot) => snapshot.sessionId === lease.ownerSessionId);
		if (activeSnapshot?.sessionPath) {
			const cwd = readSessionWorkingDirectory(activeSnapshot.sessionPath);
			if (cwd) return cwd;
		}
	}
	return process.cwd();
}

function resolveOpenAiInputTranscriptionModel(): string | null {
	const configured = process.env.PI_SPEAK_OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim();
	if (configured && ["off", "false", "none"].includes(configured.toLowerCase())) return null;
	if (configured) return configured;
	try {
		return new URL(resolveOpenAiRealtimeConnectUrl()).hostname.toLowerCase() === "api.openai.com"
			? "gpt-4o-mini-transcribe"
			: null;
	} catch {
		return null;
	}
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

// Spawn an ompk agent with stdout captured (NOT detached) so progress can be
// narrated. Used only on the NON_BLOCKING path; the detached fire-and-forget
// launch via onSessionLaunch is unchanged.
function spawnNarratedOmp(prompt: string, cwd: string) {
	const command = resolveOhMyPiCommand();
	return safeSpawn(command, ["--cwd", cwd, "--", prompt], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}

interface ActiveSession {
	sessionId: string;
	ws: WebSocket;
	reconnectToken: string;
	session: any; // Gemini Live session
	clientSequenceId: number; // last processed client sequence ID
	serverSequenceId: number; // last assigned server sequence ID
	upstreamSetupComplete: boolean;
	clientHandlersReady: boolean;
	handlersSocket?: WebSocket;
	startSent: boolean;
	reconnectingUpstream: boolean;
	disconnectTimeout?: NodeJS.Timeout;
	pendingServerMessages: { seqId: number; isBinary: boolean; data: any }[];
	terminalApprovals: RealtimeTerminalApprovalRegistry;
	pendingTerminalCalls: Map<string, PendingTerminalCall>;
	commandApprovals: RealtimeCommandApprovalRegistry;
	pendingCommandCalls: Map<string, PendingCommandCall>;
	/** camera_snapshot tool calls waiting on a client camera_frame. */
	pendingCameraCalls: Map<string, { call: { id: string; name: string }; timer?: ReturnType<typeof setTimeout> }>;
	provider: string;
	model: string;
	server: any; // store server reference
	cwd?: string;
	selectedTarget?: RealtimeSessionTargetCandidate;
	configurationError?: string;
	/** Backend of the Live connection ("developer-api" | "vertex"). */
	backend: string;
	/** True when NON_BLOCKING async function calling is available (developer-api only). */
	nonBlockingEnabled: boolean;
	/** Latest session-resumption handle from sessionResumptionUpdate. */
	resumptionHandle?: string;
	outputAudioRate: number;
	upstreamGeneration: number;
	/** FunctionResponses queued while the session is mid-reconnect. */
	pendingToolResponses: Record<string, unknown>[];
	/** Resolved Live backend kind (gemini | openai-realtime). */
	liveBackendKind: string;
	/** OpenAI-Realtime adapter session when liveBackendKind is not gemini. */
	liveBackendSession?: LiveBackendSession;
}

function getRealtimeBridge(activeSession: ActiveSession) {
	return activeSession.server?.realtimeBridge;
}

function getRealtimeDashboard(activeSession: ActiveSession) {
	return getRealtimeBridge(activeSession)?.getSessionDashboard?.()
		?? activeSession.server?.getSessionDashboard?.();
}

async function loadRealtimeTargetSources(activeSession: ActiveSession): Promise<RealtimeSessionTargetSources> {
	const bridge = getRealtimeBridge(activeSession);
	const hub = bridge?.agentHub ?? activeSession.server?.agentHubGateway;
	let hubAgents: readonly any[] = [];
	try {
		hubAgents = (await hub?.snapshot?.())?.agents ?? [];
	} catch {}
	return {
		dashboard: getRealtimeDashboard(activeSession),
		attentionSnapshots: readAttentionSnapshots(),
		hubAgents,
	};
}

function enrichRealtimeTarget(candidate: RealtimeSessionTargetCandidate): RealtimeSessionTargetCandidate {
	if (candidate.cwd || !candidate.sessionPath) return candidate;
	return { ...candidate, cwd: readSessionWorkingDirectory(candidate.sessionPath) };
}

async function getRealtimeCurrentTarget(activeSession: ActiveSession) {
	if (activeSession.selectedTarget) {
		return { ok: true as const, candidate: activeSession.selectedTarget, match: "selected-connection" as const };
	}
	const sources = await loadRealtimeTargetSources(activeSession);
	const current = selectRealtimeCurrentTarget({
		...sources,
		attentionLeader: readAttentionLeaderLease(),
	});
	return current.ok ? { ...current, candidate: enrichRealtimeTarget(current.candidate) } : current;
}

function serializeRealtimeTarget(candidate: RealtimeSessionTargetCandidate | undefined) {
	if (!candidate) return undefined;
	return {
		name: candidate.name,
		agentId: candidate.agentId,
		sessionId: candidate.sessionId,
		sessionPath: candidate.sessionPath,
		provider: candidate.provider,
		cwd: candidate.cwd,
		aliases: candidate.aliases,
		sources: candidate.sources,
	};
}

function realtimeTargetLabel(candidate: RealtimeSessionTargetCandidate): string {
	return candidate.name || candidate.agentId || candidate.sessionId || candidate.sessionPath || "unnamed session";
}

type PendingTerminalCall = {
	call: { id: string; name: string; args?: unknown };
	plan: RealtimeTerminalCommandPlan;
	timer?: ReturnType<typeof setTimeout>;
};

type PendingCommandCall = {
	call: { id: string; name: string; args?: unknown };
	kind: RealtimeCommandKind;
	description: string;
	timer?: ReturnType<typeof setTimeout>;
};

export const activeSessions = new Map<string, ActiveSession>();

// Voice-feel guidance: when a background tool runs (NON_BLOCKING), the model should
// acknowledge briefly and keep conversing instead of going silent, narrate progress
// only when it receives an update, and never narrate SILENT-scheduled updates.
export const REALTIME_SYSTEM_PROMPT = [
	"You are the realtime conversational assistant and voice control plane for Pi Speak and Oh-my-pk (OMPK).",
	"You have real tools for terminal commands, OMPK session selection and messaging, agent launch/lifecycle, workspace reads, web search, and camera input. Never say you cannot perform an available action: call the matching tool and report its actual result.",
	"Before acting on a session, call get_session_info or list_sessions. Use switch_session to select one unambiguous connection-local target, then send_session_message, resume_session, or an agent lifecycle tool as requested.",
	"Use read-only tools freely and proactively to understand real state; never guess session identity, tool output, workspace content, or camera content.",
	"When the user asks about something on camera or shows you something, call camera_snapshot immediately — do not claim you can see without it.",
	"When a request is ambiguous or could mean more than one thing, ask one short clarifying question before acting.",
	"Mutating tools require the operator's explicit approval and automatically open an approval card. Call the tool normally; do not refuse or ask for approval only in prose. Wait for the resolved tool result before claiming success.",
	"Never claim an action completed until you receive a real tool result confirming it.",
	"Do not narrate a tool's progress unless you receive an explicit progress update.",
	"When a tool result arrives, discuss it — do not read JSON, dumps, file contents, logs, or long excerpts aloud.",
	"Prefer the result's summary field when present. Mention only the facts that matter for the next decision, quote at most one short phrase when useful, and offer more detail if the user wants it.",
	"Honor speechHint guidance on tool results. Content may already be truncated for speech; say so briefly instead of inventing missing text.",
	"Do not narrate background state refreshes delivered silently.",
	"Keep replies short and conversational.",
].join(" ");

export { classifyRealtimeTerminalCommand, type RealtimeTerminalCommandSafety };

function sendLiveStartWhenReady(activeSession: ActiveSession) {
	if (!activeSession.upstreamSetupComplete || !activeSession.clientHandlersReady || activeSession.startSent) return;
	activeSession.startSent = true;
	// HF methodology: announce output PCM rate once so the playback worklet can
	// configure itself. Gemini Live native audio is 24 kHz mono PCM16.
	sendToClient(activeSession, { type: "audio_format", rate: activeSession.outputAudioRate }, false);
	sendToClient(activeSession, {
		type: "start",
		session: activeSession.sessionId,
		reconnectToken: activeSession.reconnectToken,
		message: activeSession.liveBackendKind,
	}, false);
}

export function sendToClient(activeSession: ActiveSession, message: any, isBinary: boolean) {
	const seqId = ++activeSession.serverSequenceId;
	let payload: any;
	if (isBinary) {
		// message is a Buffer containing raw audio.
		// prefix with 4-byte big-endian serverSequenceId.
		payload = Buffer.alloc(4 + message.length);
		payload.writeInt32BE(seqId, 0);
		message.copy(payload, 4);
	} else {
		// message is a JSON object.
		// add serverSequenceId to the object.
		payload = JSON.stringify({
			...message,
			serverSequenceId: seqId
		});
	}

	try {
		if (activeSession.ws.readyState === WebSocket.OPEN) {
			activeSession.ws.send(payload);
		} else {
			activeSession.pendingServerMessages.push({ seqId, isBinary, data: payload });
			if (activeSession.pendingServerMessages.length > 500) {
				activeSession.pendingServerMessages.shift();
			}
		}
	} catch (err) {
		activeSession.pendingServerMessages.push({ seqId, isBinary, data: payload });
		if (activeSession.pendingServerMessages.length > 500) {
			activeSession.pendingServerMessages.shift();
		}
	}
}

function appendTerminalAudit(activeSession: ActiveSession, event: Parameters<typeof appendRealtimeTerminalAuditEvent>[0]) {
	try {
		appendRealtimeTerminalAuditEvent({
			sessionId: activeSession.sessionId,
			provider: activeSession.provider,
			model: activeSession.model,
			...event,
		});
	} catch {
		// Audit logging must never break realtime control flow.
	}
}

function flushPendingServerMessages(activeSession: ActiveSession, lastReceivedServerSequenceId: number) {
	const toSend = activeSession.pendingServerMessages.filter(m => m.seqId > lastReceivedServerSequenceId);
	toSend.sort((a, b) => a.seqId - b.seqId);
	for (const msg of toSend) {
		try {
			if (activeSession.ws.readyState === WebSocket.OPEN) {
				activeSession.ws.send(msg.data);
			}
		} catch (err) {
			// Stop flushing if websocket has issues again
			break;
		}
	}
	activeSession.pendingServerMessages = activeSession.pendingServerMessages.filter(m => m.seqId > lastReceivedServerSequenceId);
}

async function executeRealtimeTerminalCommand(
	activeSession: ActiveSession,
	plan: RealtimeTerminalCommandPlan,
	toolCallId?: string,
	approvalId?: string,
) {
	const cwd = getCurrentCwd(activeSession);
	const result = await executeRealtimeTerminalCommandPlan(plan, cwd);
	appendTerminalAudit(activeSession, {
		kind: "terminal.execution_result",
		toolCallId,
		approvalId,
		...buildRealtimeTerminalPlanAuditFields(plan),
		cwd,
		result: buildRealtimeTerminalAuditResult(result),
	});
	return JSON.stringify({
		ok: result.ok,
		code: result.code,
		command: plan.command,
		cwd,
		timeoutMs: plan.timeoutMs,
		riskReason: plan.reason,
		commandFamily: plan.family || "unregistered",
		stdout: result.stdout,
		stderr: result.stderr,
	});
}

type ToolResponseOptions = {
	approvalId?: string;
	scheduling?: FunctionResponseScheduling;
	willContinue?: boolean;
	/** Raw response payload override; defaults to { output: outputText }. */
	response?: Record<string, unknown>;
};

export function sendRealtimeToolResponse(
	activeSession: ActiveSession,
	call: { id: string; name: string },
	outputText: string,
	opts: ToolResponseOptions = {},
) {
	// Client UI keeps the full/raw payload for inspection.
	sendToClient(activeSession, {
		type: "tool_complete",
		name: call.name,
		approvalId: opts.approvalId,
		output: outputText,
		willContinue: opts.willContinue,
	}, false);

	// The Live model gets a speech-shaped brief so it discusses findings
	// instead of reciting dumps. Explicit response overrides (progress,
	// done markers) skip shaping — those are already voice-sized.
	const modelResponse = opts.response ?? {
		output: shapeRealtimeToolOutputForSpeech(call.name, outputText),
	};

	const functionResponse: Record<string, unknown> = {
		id: call.id,
		name: call.name,
		response: modelResponse,
	};
	// scheduling/willContinue are only meaningful for NON_BLOCKING calls; harmless
	// (ignored) otherwise per the @google/genai FunctionResponse contract.
	if (opts.scheduling !== undefined) functionResponse.scheduling = opts.scheduling;
	if (opts.willContinue !== undefined) functionResponse.willContinue = opts.willContinue;

	if (activeSession.liveBackendSession?.sendToolResult) {
		const shaped = typeof modelResponse.output === "string"
			? modelResponse.output
			: JSON.stringify(modelResponse);
		try {
			if (!activeSession.liveBackendSession.sendToolResult(call.id, call.name, shaped)) {
				activeSession.pendingToolResponses.push(functionResponse);
			}
		} catch {
			activeSession.pendingToolResponses.push(functionResponse);
		}
		return;
	}

	if (activeSession.session) {
		try {
			activeSession.session.sendToolResponse({ functionResponses: [functionResponse] });
		} catch {
			// Session may be mid-reconnect; queue for delivery after resumption.
			activeSession.pendingToolResponses.push(functionResponse);
		}
	} else {
		activeSession.pendingToolResponses.push(functionResponse);
	}
}

const MEANINGFUL_LINE = /planning|executing|error|done|file written|complete|finished/i;
const NARRATION_MIN_INTERVAL_MS = 30_000;

export function summarizeAgentLine(line: string): string {
	const trimmed = line.replace(/\s+/g, " ").trim();
	return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/**
 * Tail an already-spawned process's stdout and narrate progress into the live
 * conversation. Emits intermediate FunctionResponses (willContinue:true,
 * WHEN_IDLE) on meaningful lines or every ~30s, capped to MAX_INFLIGHT_PROGRESS
 * so the model never narrates a backlog, then a final willContinue:false result.
 * Accepts any object exposing `stdout`/`stderr` Readables + an `exit`/`close`
 * event, so it is unit-testable with a fake process.
 */
export async function runWithProgressNarration(
	activeSession: ActiveSession,
	call: { id: string; name: string },
	child: {
		stdout?: NodeJS.ReadableStream | null;
		stderr?: NodeJS.ReadableStream | null;
		on(event: string, listener: (...args: any[]) => void): unknown;
	},
): Promise<void> {
	let lastNarration = 0;
	let lastLine = "";
	const tail = (chunk: Buffer | string) => {
		const text = chunk.toString();
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) continue;
			lastLine = line;
			const now = Date.now();
			const meaningful = MEANINGFUL_LINE.test(line);
			const due = now - lastNarration >= NARRATION_MIN_INTERVAL_MS;
			// Throttle to at most one progress update per interval (the first fires
			// immediately, lastNarration starting at 0). Caps backlog narration so the
			// model never reads a wall of log lines at once.
			if ((meaningful || due) && (lastNarration === 0 || due)) {
				lastNarration = now;
				sendRealtimeToolResponse(activeSession, call, summarizeAgentLine(line), {
					scheduling: FunctionResponseScheduling.WHEN_IDLE,
					willContinue: true,
					response: { progress: summarizeAgentLine(line) },
				});
			}
		}
	};
	child.stdout?.on("data", tail);
	child.stderr?.on("data", tail);
	await new Promise<void>((resolve) => {
		const finish = () => resolve();
		child.on("exit", finish);
		child.on("close", finish);
		child.on("error", finish);
	});
	sendRealtimeToolResponse(activeSession, call, lastLine || "done", {
		scheduling: FunctionResponseScheduling.WHEN_IDLE,
		willContinue: false,
		response: { done: true, lastLine },
	});
}

async function resolveTerminalApproval(
	activeSession: ActiveSession,
	approvalId: string | undefined,
	approved: boolean,
	reason = approved ? "approved" : "rejected",
) {
	const pending = approvalId ? activeSession.pendingTerminalCalls.get(approvalId) : undefined;
	const approval = reason === "expired"
		? activeSession.terminalApprovals.expire(approvalId)
		: activeSession.terminalApprovals.resolve(approvalId, approved);
	if (!approval || !pending) {
		sendToClient(activeSession, {
			type: "error",
			message: `Terminal approval not found or expired: ${approvalId || "missing"}`,
		}, false);
		return;
	}
	if (pending.timer) clearTimeout(pending.timer);
	activeSession.pendingTerminalCalls.delete(approval.id);
	appendTerminalAudit(activeSession, {
		kind: "terminal.approval_resolved",
		toolCallId: pending.call.id,
		approvalId: approval.id,
		...buildRealtimeTerminalPlanAuditFields(pending.plan),
		cwd: getCurrentCwd(activeSession),
		approved,
		decision: reason,
	});
	sendToClient(activeSession, {
		type: "tool_approval_resolved",
		approvalId: approval.id,
		name: pending.call.name,
		command: pending.plan.command,
		cwd: getCurrentCwd(activeSession),
		timeoutMs: pending.plan.timeoutMs,
		reason: pending.plan.reason,
		message: approved ? "Terminal command approved." : "Terminal command rejected.",
	}, false);

	const outputText = approved
		? await executeRealtimeTerminalCommand(activeSession, pending.plan, pending.call.id, approval.id)
		: (() => {
			appendTerminalAudit(activeSession, {
				kind: "terminal.execution_result",
				toolCallId: pending.call.id,
				approvalId: approval.id,
				...buildRealtimeTerminalPlanAuditFields(pending.plan),
				cwd: getCurrentCwd(activeSession),
				result: buildRealtimeTerminalAuditResult({
					ok: false,
					code: null,
					skipped: reason === "expired" ? "expired" : "rejected",
				}),
			});
			return JSON.stringify({
			ok: false,
			rejected: true,
			requiresConfirmation: true,
			reason,
			command: pending.plan.command,
			cwd: getCurrentCwd(activeSession),
			timeoutMs: pending.plan.timeoutMs,
			riskReason: pending.plan.reason,
			commandFamily: pending.plan.family || "unregistered",
			message: "Realtime terminal command was not approved by the operator.",
			});
		})();
	sendRealtimeToolResponse(activeSession, pending.call, outputText, { approvalId: approval.id, scheduling: FunctionResponseScheduling.INTERRUPT });
}

// A launch_agent call is navigational (just opens the hub/dashboard, mutates
// nothing) when hubOnly is set, or when there is neither a prompt nor a
// targetNode to actually launch/deploy. A targetNode is always a deployment
// (e.g. "colab") regardless of hubOnly, so it always requires approval --
// hubOnly must not be usable to smuggle a deploy past the approval boundary.
// Pulled out as a pure function so the approval-boundary decision is
// unit-testable without a live Gemini session.
export function isNavigationalLaunch(args: { prompt?: string; hubOnly?: boolean; targetNode?: string }): boolean {
	return !args.targetNode && (!!args.hubOnly || !args.prompt);
}

// Gate a mutating tool call (launch_agent, archive_session) behind operator
// approval instead of running it. Mirrors the execute_terminal_command
// confirmation flow above, but keyed on kind+description rather than a raw
// shell command since these mutations don't have one canonical command string.
function requestCommandApproval(
	activeSession: ActiveSession,
	toolCall: { id: string; name: string },
	args: unknown,
	kind: RealtimeCommandKind,
	description: string,
) {
	const approval = activeSession.commandApprovals.request(kind, description);
	const timeoutMs = Math.max(0, approval.expiresAt - Date.now());
	const timer = setTimeout(() => {
		resolveCommandApproval(activeSession, approval.id, false, "expired").catch((err) => {
			sendToClient(activeSession, { type: "error", message: `Command approval expiry failed: ${err instanceof Error ? err.message : String(err)}` }, false);
		});
	}, timeoutMs);
	timer.unref?.();
	activeSession.pendingCommandCalls.set(approval.id, {
		call: { ...toolCall, args },
		kind,
		description,
		timer,
	});
	appendTerminalAudit(activeSession, {
		kind: "command.approval_requested",
		toolCallId: toolCall.id,
		approvalId: approval.id,
		commandKind: kind,
		description,
	});
	sendToClient(activeSession, {
		type: "tool_approval_required",
		approvalId: approval.id,
		name: toolCall.name,
		command: description,
		timeoutMs,
		reason: kind,
		message: "Confirm to run this action.",
	}, false);
}

async function executeLaunchAgentMutation(
	activeSession: ActiveSession,
	call: { id: string; name: string },
	args: Record<string, unknown>,
): Promise<string | undefined> {
	const prompt = args.prompt as string | undefined;
	const cwd = (args.cwd as string | undefined) || getCurrentCwd(activeSession);
	const hubOnly = args.hubOnly as boolean | undefined;
	const targetNode = args.targetNode as string | undefined;
	if (activeSession.nonBlockingEnabled && prompt && !hubOnly && !targetNode) {
		const narratedPrompt = normalizeOptionalString(prompt, 4096, "prompt");
		if (typeof narratedPrompt !== "string") {
			return JSON.stringify({ ok: false, error: narratedPrompt?.error || "Invalid prompt." });
		}
		// Narrated launch streams progress via its own tool responses
		// (willContinue:true/false); the caller must not send another one.
		const child = spawnNarratedOmp(narratedPrompt, cwd);
		void runWithProgressNarration(activeSession, call, child);
		sendToClient(activeSession, { type: "tool_progress", name: call.name, message: "Launching agent…" }, false);
		return undefined;
	}
	const bridge = getRealtimeBridge(activeSession);
	if (bridge?.launchSession) {
		const result = await bridge.launchSession({ prompt, cwd, hubOnly, targetNode });
		return JSON.stringify(result);
	}
	if (activeSession.server && typeof activeSession.server.onSessionLaunch === "function") {
		const result = await activeSession.server.onSessionLaunch({ prompt, cwd, hubOnly, targetNode });
		return JSON.stringify(result);
	}
	return JSON.stringify({ ok: false, error: "Session launch is not available." });
}

async function executeArchiveSessionMutation(
	activeSession: ActiveSession,
	args: Record<string, unknown>,
): Promise<string> {
	const sessionPath = args.sessionPath as string | undefined;
	const action = (args.action as string) === "recover" ? "recover" : "archive";
	if (!sessionPath) return JSON.stringify({ ok: false, error: "Missing 'sessionPath' argument" });
	const bridge = getRealtimeBridge(activeSession);
	if (bridge?.archiveSession) {
		return JSON.stringify(await bridge.archiveSession({ sessionPath, action }));
	}
	if (activeSession.server && typeof activeSession.server.onSessionArchive === "function") {
		const result = await activeSession.server.onSessionArchive({ sessionPath, action });
		return JSON.stringify(result);
	}
	return JSON.stringify({ ok: false, error: "Session archive is not available." });
}

async function executeResumeSessionMutation(activeSession: ActiveSession, args: Record<string, unknown>): Promise<string> {
	const target = (args.target ?? {}) as Record<string, unknown>;
	const bridge = getRealtimeBridge(activeSession);
	if (!bridge?.resumeSession) return JSON.stringify({ ok: false, error: "Session resume is not available." });
	const result = await bridge.resumeSession({
		sessionPath: target.sessionPath as string | undefined,
		sessionId: target.sessionId as string | undefined,
		provider: target.provider as string | undefined,
		cwd: target.cwd as string | undefined,
	});
	return JSON.stringify(result);
}

async function executeSendSessionMessageMutation(activeSession: ActiveSession, args: Record<string, unknown>): Promise<string> {
	const text = normalizeOptionalString(args.text, 8192, "text");
	if (typeof text !== "string") return JSON.stringify({ ok: false, error: text?.error || "Invalid message." });
	const target = (args.target ?? {}) as Record<string, unknown>;
	const bridge = getRealtimeBridge(activeSession);
	const agentId = parseHubAgentId(target.agentId as string | undefined);
	if (agentId && bridge?.agentHub?.chat) {
		const result = await bridge.agentHub.chat(agentId, text, `realtime-${activeSession.sessionId}-${randomUUID()}`);
		return JSON.stringify(result);
	}
	if (!bridge?.sendSessionTurn) return JSON.stringify({ ok: false, error: "Session messaging is not available." });
	const result = await bridge.sendSessionTurn(text, target);
	const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
	return JSON.stringify({
		ok: warnings.length === 0,
		target: target.name || target.sessionId || target.sessionPath,
		result,
	});
}

async function executeAgentLifecycleMutation(
	activeSession: ActiveSession,
	kind: "kill_agent" | "revive_agent",
	args: Record<string, unknown>,
): Promise<string> {
	const id = parseHubAgentId(args.id as string | undefined);
	if (!id) return JSON.stringify({ ok: false, error: "Missing or invalid agent id." });
	const hub = getRealtimeBridge(activeSession)?.agentHub;
	if (!hub) return JSON.stringify({ ok: false, error: "Agent hub mutation bridge is not available." });
	if (kind === "revive_agent") return JSON.stringify(await hub.revive(id));
	const confirmation = await hub.kill(id, undefined);
	if (!confirmation.ok && confirmation.code === "confirm_required") {
		return JSON.stringify(await hub.kill(id, confirmation.confirmToken));
	}
	return JSON.stringify(confirmation);
}

async function executeApprovedCommandMutation(
	activeSession: ActiveSession,
	pending: PendingCommandCall,
	args: Record<string, unknown>,
): Promise<string | undefined> {
	switch (pending.kind) {
		case "launch_agent": return await executeLaunchAgentMutation(activeSession, pending.call, args);
		case "archive_session": return await executeArchiveSessionMutation(activeSession, args);
		case "resume_session": return await executeResumeSessionMutation(activeSession, args);
		case "send_session_message": return await executeSendSessionMessageMutation(activeSession, args);
		case "kill_agent":
		case "revive_agent": return await executeAgentLifecycleMutation(activeSession, pending.kind, args);
	}
}

async function resolveCommandApproval(
	activeSession: ActiveSession,
	approvalId: string | undefined,
	approved: boolean,
	reason = approved ? "approved" : "rejected",
) {
	const pending = approvalId ? activeSession.pendingCommandCalls.get(approvalId) : undefined;
	const approval = reason === "expired"
		? activeSession.commandApprovals.expire(approvalId)
		: activeSession.commandApprovals.resolve(approvalId, approved);
	if (!approval || !pending) {
		sendToClient(activeSession, {
			type: "error",
			message: `Command approval not found or expired: ${approvalId || "missing"}`,
		}, false);
		return;
	}
	if (pending.timer) clearTimeout(pending.timer);
	activeSession.pendingCommandCalls.delete(approval.id);
	appendTerminalAudit(activeSession, {
		kind: "command.approval_resolved",
		toolCallId: pending.call.id,
		approvalId: approval.id,
		commandKind: pending.kind,
		description: pending.description,
		approved,
		decision: reason,
	});
	sendToClient(activeSession, {
		type: "tool_approval_resolved",
		approvalId: approval.id,
		name: pending.call.name,
		command: pending.description,
		reason: pending.kind,
		message: approved ? "Action approved." : "Action rejected.",
	}, false);

	if (!approved) {
		appendTerminalAudit(activeSession, {
			kind: "command.execution_result",
			toolCallId: pending.call.id,
			approvalId: approval.id,
			commandKind: pending.kind,
			description: pending.description,
			result: buildRealtimeTerminalAuditResult({ ok: false, code: null, skipped: reason === "expired" ? "expired" : "rejected" }),
		});
		sendRealtimeToolResponse(activeSession, pending.call, JSON.stringify({
			ok: false,
			rejected: true,
			requiresConfirmation: true,
			reason,
			description: pending.description,
			message: "This action was not approved by the operator.",
		}), { approvalId: approval.id, scheduling: FunctionResponseScheduling.INTERRUPT });
		return;
	}

	const args = (pending.call.args ?? {}) as Record<string, unknown>;
	let outputText: string | undefined;
	try {
		outputText = await executeApprovedCommandMutation(activeSession, pending, args);
	} catch (err: any) {
		outputText = JSON.stringify({ ok: false, error: err?.message || String(err) });
	}
	appendTerminalAudit(activeSession, {
		kind: "command.execution_result",
		toolCallId: pending.call.id,
		approvalId: approval.id,
		commandKind: pending.kind,
		description: pending.description,
		result: buildRealtimeTerminalAuditResult({ ok: resultLooksOk(outputText), stdout: outputText ?? "dispatched (narrated launch; result streams separately)" }),
	});
	// undefined means the narrated-launch path already sent its own response(s).
	if (outputText === undefined) return;
	sendRealtimeToolResponse(activeSession, pending.call, outputText, { approvalId: approval.id, scheduling: FunctionResponseScheduling.INTERRUPT });
}

function resultLooksOk(outputText: string | undefined): boolean {
	if (outputText === undefined) return true;
	try {
		const parsed = JSON.parse(outputText);
		return typeof parsed?.ok === "boolean" ? parsed.ok : true;
	} catch {
		return true;
	}
}


export const CAMERA_CAPTURE_TIMEOUT_MS = 15_000;

function normalizeImageMimeType(raw: string | undefined): string {
	const value = (raw || "image/jpeg").trim().toLowerCase();
	if (value === "image/jpg" || value === "image/jpeg") return "image/jpeg";
	if (value === "image/png" || value === "image/webp" || value === "image/gif") return value;
	return "image/jpeg";
}

function stripDataUrl(data: string): { mimeType?: string; base64: string } {
	const match = /^data:([^;]+);base64,(.+)$/i.exec(data.trim());
	if (match) return { mimeType: match[1], base64: match[2] };
	return { base64: data.trim() };
}

function sendImageToLiveSession(activeSession: ActiveSession, data: string, mimeType?: string, deferResponse = false): boolean {
	if (!data.trim()) return false;
	const parsed = stripDataUrl(data);
	const mime = normalizeImageMimeType(mimeType || parsed.mimeType);
	if (activeSession.liveBackendSession?.sendImage) {
		try {
			return activeSession.liveBackendSession.sendImage({ data: parsed.base64, mimeType: mime, deferResponse }) !== false;
		} catch {
			return false;
		}
	}
	if (!activeSession.session) return false;
	try {
		activeSession.session.sendRealtimeInput({ media: { mimeType: mime, data: parsed.base64 } });
		return true;
	} catch {
		return false;
	}
}

export function clearPendingCameraCall(activeSession: ActiveSession, callId: string | undefined): void {
	if (!callId) return;
	const pending = activeSession.pendingCameraCalls.get(callId);
	if (!pending) return;
	if (pending.timer) clearTimeout(pending.timer);
	activeSession.pendingCameraCalls.delete(callId);
}

export function handleClientImage(activeSession: ActiveSession, ctrl: RealtimeControlMessage): void {
	const data = typeof ctrl.data === "string" ? ctrl.data : "";
	if (!data.trim()) {
		if (ctrl.callId) {
			clearPendingCameraCall(activeSession, ctrl.callId);
			sendRealtimeToolResponse(activeSession, { id: ctrl.callId, name: "camera_snapshot" }, JSON.stringify({
				ok: false,
				error: "Camera frame was empty.",
			}));
		}
		return;
	}
	const pendingCameraTool = !!ctrl.callId && activeSession.pendingCameraCalls.has(ctrl.callId);
	const delivered = sendImageToLiveSession(activeSession, data, ctrl.mimeType, pendingCameraTool);
	if (pendingCameraTool && ctrl.callId) {
		const pending = activeSession.pendingCameraCalls.get(ctrl.callId);
		clearPendingCameraCall(activeSession, ctrl.callId);
		if (pending) {
			sendRealtimeToolResponse(activeSession, pending.call, JSON.stringify({
				ok: delivered,
				message: delivered
					? "Camera frame captured and attached. Describe what you see."
					: "Camera frame arrived but could not be delivered to the live model.",
			}));
			sendToClient(activeSession, {
				type: "tool_complete",
				name: "camera_snapshot",
				output: delivered ? "frame attached" : "frame delivery failed",
			}, false);
		}
		return;
	}
	if (!delivered) {
		sendToClient(activeSession, { type: "error", message: "Failed to send image to the live model." }, false);
	}
}

export function requestCameraSnapshot(
	activeSession: ActiveSession,
	toolCall: { id: string; name: string },
	reason?: string,
): void {
	const timer = setTimeout(() => {
		if (!activeSession.pendingCameraCalls.has(toolCall.id)) return;
		activeSession.pendingCameraCalls.delete(toolCall.id);
		sendRealtimeToolResponse(activeSession, toolCall, JSON.stringify({
			ok: false,
			error: "Timed out waiting for a camera frame from the client.",
		}));
		sendToClient(activeSession, {
			type: "tool_complete",
			name: "camera_snapshot",
			output: "timeout",
		}, false);
	}, CAMERA_CAPTURE_TIMEOUT_MS);
	timer.unref?.();
	activeSession.pendingCameraCalls.set(toolCall.id, { call: toolCall, timer });
	sendToClient(activeSession, {
		type: "camera_capture",
		callId: toolCall.id,
		reason: reason || "The assistant wants to look through your camera.",
	}, false);
}

function setupSocketHandlers(activeSession: ActiveSession) {
	const ws = activeSession.ws;
	if (activeSession.handlersSocket === ws) return;
	activeSession.handlersSocket = ws;
	
	ws.on("message", (rawMsg, isBinary) => {
		if (activeSession.ws !== ws) return;
		try {
			if (isBinary) {
				// Binary message is [4 bytes sequence ID] [raw PCM audio frame] from client
				if (rawMsg.length >= 4) {
					const seqId = rawMsg.readInt32BE(0);
					if (seqId <= activeSession.clientSequenceId) {
						// Deduplicate / Discard
						return;
					}
					activeSession.clientSequenceId = seqId;
					const audioBuf = rawMsg.subarray(4);
					if (activeSession.liveBackendSession) {
						activeSession.liveBackendSession.sendAudio({ pcm: audioBuf, sampleRate: 16000 });
					} else if (activeSession.session) {
						activeSession.session.sendRealtimeInput({
							media: {
								mimeType: "audio/pcm;rate=16000",
								data: audioBuf.toString("base64"),
							}
						});
					}
				}
			} else {
				// Text message is JSON stringified control event
				const textMsg = rawMsg.toString("utf8");
				const ctrl = JSON.parse(textMsg) as RealtimeControlMessage;
				
				if (ctrl.clientSequenceId !== undefined) {
					activeSession.clientSequenceId = Math.max(activeSession.clientSequenceId, ctrl.clientSequenceId);
				}

				if (ctrl.type === "configure") {
					const requested = ctrl.cwd?.trim();
					if (!requested) {
						activeSession.configurationError = "A live workspace path is required.";
						sendToClient(activeSession, { type: "error", message: activeSession.configurationError }, false);
						return;
					}
					const workspace = listWorkspaceDirectory(requested);
					const current = resolve(workspace.current);
					const expected = resolve(requested);
					const matches = process.platform === "win32" ? current.toLowerCase() === expected.toLowerCase() : current === expected;
					if (!matches) {
						activeSession.configurationError = `Live workspace is outside the gateway root: ${workspace.root}`;
						sendToClient(activeSession, { type: "error", message: activeSession.configurationError }, false);
						return;
					}
					activeSession.cwd = workspace.current;
					return;
				}

				if (ctrl.type === "terminal_approve" || ctrl.type === "terminal_reject") {
					resolveTerminalApproval(activeSession, ctrl.approvalId, ctrl.type === "terminal_approve").catch((err) => {
						sendToClient(activeSession, { type: "error", message: `Terminal approval failed: ${err instanceof Error ? err.message : String(err)}` }, false);
					});
				} else if (ctrl.type === "command_approve" || ctrl.type === "command_reject") {
					resolveCommandApproval(activeSession, ctrl.approvalId, ctrl.type === "command_approve").catch((err) => {
						sendToClient(activeSession, { type: "error", message: `Command approval failed: ${err instanceof Error ? err.message : String(err)}` }, false);
					});
				} else if (ctrl.type === "interrupt") {
					// Barge-in / Interrupt from client
					if (activeSession.liveBackendSession) {
						// The adapter emits the canonical interrupt event after cancelling upstream.
						activeSession.liveBackendSession.interrupt();
					} else if (activeSession.session) {
						activeSession.session.sendRealtimeInput({ activityStart: {} });
						sendToClient(activeSession, { type: "interrupt" }, false);
					}
				} else if (ctrl.type === "text" && ctrl.text) {
					// Text turn from client
					if (activeSession.liveBackendSession) {
						activeSession.liveBackendSession.sendText(ctrl.text);
					} else if (activeSession.session) {
						activeSession.session.sendClientContent({
							turns: [{ role: "user", parts: [{ text: ctrl.text }] }],
							turnComplete: true,
						});
					}
				} else if (ctrl.type === "camera_frame" || ctrl.type === "image") {
					handleClientImage(activeSession, ctrl);
				}
			}
		} catch (err: any) {
			sendToClient(activeSession, {
				type: "error",
				message: `Error processing message: ${err.message}`,
			}, false);
		}
	});

	ws.on("close", () => {
		if (activeSession.ws !== ws) return;
		// A prior disconnect timer may still be pending if this socket churned;
		// clear it so we keep a single grace timer, not a growing pile.
		if (activeSession.disconnectTimeout) clearTimeout(activeSession.disconnectTimeout);
		activeSession.disconnectTimeout = setTimeout(() => {
			try {
				activeSession.session?.close();
			} catch {}
			activeSessions.delete(activeSession.sessionId);
		}, 60000); // 60 seconds grace for client reconnect/resume
		// unref so a lingering grace timer never blocks process shutdown (matches the
		// approval/init timers); the session still closes on the next tick if idle.
		activeSession.disconnectTimeout.unref?.();
	});
}

type ReconnectContext = {
	resumptionHandle?: string;
	pendingToolResponses: Record<string, unknown>[];
	priorSessionId: string;
	cwd?: string;
	activeSession?: ActiveSession;
};

// Extracted (rather than inlined in startNewSession) so the tool surface —
// what the assistant can read freely vs. what requires operator approval —
// is unit-testable independently of a live Gemini Live connection.
async function dispatchRealtimeToolCall(
	activeSession: ActiveSession,
	toolCall: { id: string; name: string },
	callArgs: Record<string, unknown> | undefined,
): Promise<{ deferToolResponse: boolean; outputText: string }> {
	let deferToolResponse = false;
	let outputText = "";
	const call = { id: toolCall.id, name: toolCall.name, args: callArgs ?? {} };
	try {
				if (call.name === "execute_terminal_command") {
					const command = call.args?.command as string;
					if (!command) {
						outputText = JSON.stringify({ ok: false, error: "Missing 'command' argument" });
						appendTerminalAudit(activeSession, {
							kind: "terminal.request",
							toolCallId: toolCall.id,
							command: "",
							action: "requires_confirmation",
							reason: "missing-command",
							cwd: getCurrentCwd(activeSession),
						});
						appendTerminalAudit(activeSession, {
							kind: "terminal.execution_result",
							toolCallId: toolCall.id,
							command: "",
							action: "requires_confirmation",
							reason: "missing-command",
							cwd: getCurrentCwd(activeSession),
							result: buildRealtimeTerminalAuditResult({
								ok: false,
								code: null,
								skipped: "missing-command",
								stderr: "Missing 'command' argument",
							}),
						});
					} else {
						const plan = buildRealtimeTerminalCommandPlan(command);
						appendTerminalAudit(activeSession, {
							kind: "terminal.request",
							toolCallId: toolCall.id,
							...buildRealtimeTerminalPlanAuditFields(plan),
							cwd: getCurrentCwd(activeSession),
						});
						if (plan.action !== "allow") {
							outputText = JSON.stringify({
								ok: false,
								requiresConfirmation: true,
								reason: plan.reason,
								command,
								cwd: getCurrentCwd(activeSession),
								timeoutMs: plan.timeoutMs,
								commandFamily: plan.family || "unregistered",
								executableKnown: plan.executableKnown,
								secretInspection: plan.secretInspection,
								message: "Realtime terminal execution is limited to read-only allowlisted commands. Ask the user for explicit confirmation before running this command outside the realtime tool.",
							});
							const approval = activeSession.terminalApprovals.request(command, plan.reason);
							const timeoutMs = Math.max(0, approval.expiresAt - Date.now());
							const timer = setTimeout(() => {
								resolveTerminalApproval(activeSession, approval.id, false, "expired").catch((err) => {
									sendToClient(activeSession, { type: "error", message: `Terminal approval expiry failed: ${err instanceof Error ? err.message : String(err)}` }, false);
								});
							}, timeoutMs);
							timer.unref?.();
							activeSession.pendingTerminalCalls.set(approval.id, {
								call: { ...toolCall, args: call.args },
								plan,
								timer,
							});
							appendTerminalAudit(activeSession, {
								kind: "terminal.approval_requested",
								toolCallId: toolCall.id,
								approvalId: approval.id,
								...buildRealtimeTerminalPlanAuditFields(plan),
								cwd: getCurrentCwd(activeSession),
							});
							sendToClient(activeSession, {
								type: "tool_approval_required",
								approvalId: approval.id,
								name: call.name,
								command,
								cwd: getCurrentCwd(activeSession),
								timeoutMs: plan.timeoutMs,
								reason: plan.reason,
								message: "Confirm to run this terminal command.",
								output: outputText,
							}, false);
							deferToolResponse = true;
						} else if (activeSession.nonBlockingEnabled) {
							// NON_BLOCKING: run the allowlisted command without blocking the
							// receive loop; deliver the result at the next natural pause.
							deferToolResponse = true;
							executeRealtimeTerminalCommand(activeSession, plan, toolCall.id)
								.then((result) => {
									sendRealtimeToolResponse(activeSession, toolCall, result, {
										scheduling: FunctionResponseScheduling.WHEN_IDLE,
									});
								})
								.catch((err) => {
									sendRealtimeToolResponse(activeSession, toolCall, JSON.stringify({ ok: false, error: err?.message || String(err) }), {
										scheduling: FunctionResponseScheduling.INTERRUPT,
									});
								});
						} else {
							outputText = await executeRealtimeTerminalCommand(activeSession, plan, toolCall.id);
						}
					}
				} else if (call.name === "switch_session") {
					const target = call.args?.name as string | undefined;
					const sources = await loadRealtimeTargetSources(activeSession);
					const resolved = resolveRealtimeSessionTarget(target, sources);
					if (!resolved.ok) {
						outputText = JSON.stringify({
							ok: false,
							code: resolved.reason,
							error: resolved.reason === "ambiguous"
								? `Session target is ambiguous: ${target}`
								: `Session not found: ${target || "(missing)"}`,
							matches: resolved.candidates?.map(serializeRealtimeTarget),
						});
					} else {
						activeSession.selectedTarget = enrichRealtimeTarget(resolved.candidate);
						outputText = JSON.stringify({
							ok: true,
							message: `Selected ${realtimeTargetLabel(activeSession.selectedTarget)} for this live connection.`,
							match: resolved.match,
							target: serializeRealtimeTarget(activeSession.selectedTarget),
						});
					}
				} else if (call.name === "get_session_info") {
					const persisted = loadPersistedSessionRouting();
					const snapshots = readAttentionSnapshots();
					const lease = readAttentionLeaderLease();
					const current = await getRealtimeCurrentTarget(activeSession);
					const target = current.ok ? current.candidate : undefined;
					outputText = JSON.stringify({
						ok: true,
						currentSession: target ? realtimeTargetLabel(target) : "none selected",
						selectedForConnection: !!activeSession.selectedTarget,
						target: serializeRealtimeTarget(target),
						currentCwd: getCurrentCwd(activeSession),
						attentionLeader: lease?.ownerSessionId,
						persistedSessions: persisted.sessions,
						persistedAliases: persisted.aliases,
						runningSnapshots: snapshots.map((snapshot) => ({
							sessionId: snapshot.sessionId,
							sessionName: snapshot.sessionName,
							sessionPath: snapshot.sessionPath,
							pid: snapshot.pid,
							phase: snapshot.phase,
							waitingForAttention: snapshot.waitingForAttention,
						})),
					});
				} else if (call.name === "get_realtime_capabilities") {
					const bridge = getRealtimeBridge(activeSession);
					outputText = JSON.stringify({
						ok: true,
						backend: activeSession.liveBackendKind,
						model: activeSession.model,
						features: {
							fullDuplexAudio: true,
							bargeIn: true,
							inputTranscription: activeSession.liveBackendKind === "gemini" || resolveOpenAiInputTranscriptionModel() !== null,
							camera: typeof activeSession.liveBackendSession?.sendImage === "function" || activeSession.liveBackendKind === "gemini",
							tools: true,
							nonBlockingTools: activeSession.nonBlockingEnabled,
							sessionResumption: activeSession.liveBackendKind === "gemini",
							sessionRead: bridge?.capabilities?.sessionRead ?? !!activeSession.server?.getSessionDashboard,
							sessionMessage: bridge?.capabilities?.sessionMessage ?? false,
							sessionResume: bridge?.capabilities?.sessionResume ?? false,
							agentHubMutations: bridge?.capabilities?.agentHubMutations ?? false,
						},
					});
				} else if (call.name === "list_sessions") {
					const dashboard = getRealtimeDashboard(activeSession);
					const sources = await loadRealtimeTargetSources(activeSession);
					const current = await getRealtimeCurrentTarget(activeSession);
					const candidates = buildRealtimeSessionCandidates(sources);
					outputText = JSON.stringify({
						ok: true,
						current: current.ok ? serializeRealtimeTarget(current.candidate) : undefined,
						dashboardCurrent: dashboard?.current,
						sessions: candidates.map(serializeRealtimeTarget),
						workspaces: dashboard?.workspaces ?? [],
					});
				} else if (call.name === "launch_agent") {
			const prompt = call.args?.prompt as string | undefined;
			const cwd = (call.args?.cwd as string | undefined) || getCurrentCwd(activeSession);
			const hubOnly = call.args?.hubOnly as boolean | undefined;
			const targetNode = call.args?.targetNode as string | undefined;
			if (isNavigationalLaunch({ prompt, hubOnly, targetNode })) {
		// Navigational only (opens the hub/dashboard); nothing mutates, so no approval needed.
		const bridge = getRealtimeBridge(activeSession);
		if (bridge?.launchSession) {
			const result = await bridge.launchSession({ prompt, cwd, hubOnly: true, targetNode });
			outputText = JSON.stringify(result);
		} else if (activeSession.server && typeof activeSession.server.onSessionLaunch === "function") {
			const result = await activeSession.server.onSessionLaunch({ prompt, cwd, hubOnly: true, targetNode });
			outputText = JSON.stringify(result);
		} else {
			outputText = JSON.stringify({ ok: false, error: "Session launch is not available." });
		}
			} else {
		// Distill the model's free-form prompt through the conversation
		// reducer before anything launches: the coding agent receives a
		// structured task packet (Goal / action items / constraints), and
		// vague or low-confidence intent becomes a spoken clarification
		// instead of an approval request. Mirrors the turn-based path
		// (reduceConversationTurn in index.ts). The distilled packet is
		// frozen into the approval args, so the approved continuation
		// executes exactly what the operator saw.
		let distilledPrompt = prompt;
		let goalLine: string | undefined;
		if (prompt && !targetNode) {
			const reduction = await reduceConversationTurn(prompt, { source: "realtime" });
			if (!reduction.dispatch) {
				outputText = JSON.stringify({
					ok: false,
					needsClarification: true,
					confidence: reduction.summary.confidence,
					message: reduction.replyText,
				});
			} else {
				distilledPrompt = reduction.promptForAgent;
				goalLine = reduction.summary.goal;
			}
		}
		if (!outputText) {
			const description = targetNode
				? `Deploy this workspace to ${targetNode}.`
				: `Launch a new background agent in ${cwd}${goalLine ? ` with goal: "${goalLine}"` : prompt ? ` with prompt: "${prompt}"` : ""}.`;
			deferToolResponse = true;
			requestCommandApproval(activeSession, toolCall, { prompt: distilledPrompt, cwd, hubOnly, targetNode }, "launch_agent", description);
		}
			}
				} else if (call.name === "resume_session") {
					const requested = call.args?.target as string | undefined;
					const sources = await loadRealtimeTargetSources(activeSession);
					const resolved = requested
						? resolveRealtimeSessionTarget(requested, sources)
						: await getRealtimeCurrentTarget(activeSession);
					if (!resolved.ok) {
						outputText = JSON.stringify({ ok: false, code: resolved.reason, error: "Select one unambiguous session before resuming it." });
					} else if (resolved.candidate.isCurrent || resolved.candidate.sources.includes("attention")) {
						// UX precheck; onSessionResume re-checks at execution time to close the TOCTOU window.
						outputText = JSON.stringify({
							ok: false,
							code: "session-already-active",
							error: `${realtimeTargetLabel(resolved.candidate)} is currently running. Use send_session_message to reach an active session instead of resuming it.`,
						});
					} else {
						const target = enrichRealtimeTarget(resolved.candidate);
						deferToolResponse = true;
						requestCommandApproval(activeSession, toolCall, { target: serializeRealtimeTarget(target) }, "resume_session", `Resume ${realtimeTargetLabel(target)}.`);
					}
				} else if (call.name === "send_session_message") {
					const text = call.args?.text as string | undefined;
					const requested = call.args?.target as string | undefined;
					const sources = await loadRealtimeTargetSources(activeSession);
					const resolved = requested
						? resolveRealtimeSessionTarget(requested, sources)
						: await getRealtimeCurrentTarget(activeSession);
					if (!text?.trim()) {
						outputText = JSON.stringify({ ok: false, error: "Missing 'text' argument." });
					} else if (!resolved.ok) {
						outputText = JSON.stringify({ ok: false, code: resolved.reason, error: "Select one unambiguous session before messaging it." });
					} else {
						const target = enrichRealtimeTarget(resolved.candidate);
						deferToolResponse = true;
						requestCommandApproval(
							activeSession,
							toolCall,
							{ text, target: serializeRealtimeTarget(target) },
							"send_session_message",
							`Send a message to ${realtimeTargetLabel(target)}: "${text.slice(0, 160)}"`,
						);
					}
				} else if (call.name === "kill_agent" || call.name === "revive_agent") {
					const id = parseHubAgentId(call.args?.id as string | undefined);
					if (!id) {
						outputText = JSON.stringify({ ok: false, error: "Missing or invalid agent id." });
					} else {
						const kind = call.name as "kill_agent" | "revive_agent";
						deferToolResponse = true;
						requestCommandApproval(activeSession, toolCall, { id }, kind, `${kind === "kill_agent" ? "Archive/stop" : "Revive"} agent ${id}.`);
					}
				} else if (call.name === "archive_session") {
					const sessionPath = call.args?.sessionPath as string;
					const action = (call.args?.action as string) === "recover" ? "recover" : "archive";
					if (!sessionPath) {
						outputText = JSON.stringify({ ok: false, error: "Missing 'sessionPath' argument" });
					} else {
						const description = `${action === "recover" ? "Recover" : "Archive"} session ${sessionPath}.`;
						deferToolResponse = true;
						requestCommandApproval(activeSession, toolCall, { sessionPath, action }, "archive_session", description);
					}
				} else if (call.name === "list_agent_hub_agents") {
					const hub = getRealtimeBridge(activeSession)?.agentHub ?? activeSession.server?.agentHubGateway;
					if (hub) {
						const snapshot = await hub.snapshot();
						outputText = JSON.stringify({ ok: true, folders: snapshot.folders, agents: snapshot.agents });
					} else {
						outputText = JSON.stringify({ ok: false, error: "Agent hub is not available." });
					}
				} else if (call.name === "get_agent_hub_agent") {
					const rawId = call.args?.id as string | undefined;
					const id = parseHubAgentId(rawId);
					const tailLines = typeof call.args?.tailLines === "number" ? call.args.tailLines : 40;
					if (!id) {
						outputText = JSON.stringify({ ok: false, error: `Missing or invalid 'id' argument: ${rawId ?? ""}` });
					} else {
						const hub = getRealtimeBridge(activeSession)?.agentHub ?? activeSession.server?.agentHubGateway;
						if (!hub) {
							outputText = JSON.stringify({ ok: false, error: "Agent hub is not available." });
						} else {
							const detail = await hub.detail(id, Math.min(Math.max(tailLines, 1), 500));
							outputText = detail ? JSON.stringify({ ok: true, agent: detail }) : JSON.stringify({ ok: false, error: `Unknown agent: ${id}` });
						}
					}
				} else if (call.name === "browse_workspace") {
					outputText = JSON.stringify({ ok: true, workspace: listWorkspaceDirectory(call.args?.path as string | undefined) });
				} else if (call.name === "read_workspace_file") {
					const requestedPath = call.args?.path as string | undefined;
					if (requestedPath && looksLikeSecretPath(requestedPath)) {
						outputText = JSON.stringify({ ok: false, error: "Refusing to read a file that looks like it may hold secrets or credentials." });
					} else {
						const result = readWorkspaceFile(requestedPath);
						// The requested path alone isn't enough: it could be an
						// innocuously-named symlink pointing at a secret file, so
						// also gate on the symlink-resolved real path before the
						// content (already read into memory) is ever returned.
						if (result.ok && looksLikeSecretPath(result.realPath)) {
							outputText = JSON.stringify({ ok: false, error: "Refusing to read a file that looks like it may hold secrets or credentials." });
						} else {
							outputText = result.ok
								? JSON.stringify({ ok: true, file: { name: result.name, path: result.path, size: result.size, truncated: result.truncated, binary: result.binary, content: result.content } })
								: JSON.stringify({ ok: false, error: result.error });
						}
					}
				} else if (call.name === "web_search") {
					const query = typeof call.args?.query === "string" ? call.args.query : "";
					if (!query.trim()) {
						outputText = JSON.stringify({ ok: false, error: "Missing 'query' argument" });
					} else if (!isWebSearchConfigured()) {
						outputText = JSON.stringify({
							ok: false,
							error: "Web search is not configured. Set SERPER_API_KEY or PI_SPEAK_SERPER_API_KEY on the gateway.",
						});
					} else {
						const result = await runWebSearch(query);
						if (!result.ok) {
							outputText = JSON.stringify({ ok: false, error: result.error });
						} else {
							outputText = JSON.stringify({
								ok: true,
								query: result.query,
								answer: result.answer,
								results: result.results,
								summary: formatWebSearchForSpeech(result),
								speechHint: "Summarize the top findings in one or two short spoken sentences. Do not read every link.",
							});
						}
					}
				} else if (call.name === "camera_snapshot") {
					const reason = typeof call.args?.reason === "string" ? call.args.reason : undefined;
					deferToolResponse = true;
					requestCameraSnapshot(activeSession, toolCall, reason);
				} else {
					outputText = JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
				}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		outputText = JSON.stringify({ ok: false, error: message });
	}
	return { deferToolResponse, outputText };
}

export function buildRealtimeTools(nonBlockingEnabled: boolean) {
	return [
		{
			functionDeclarations: [
				{
					name: "execute_terminal_command",
					description: "Executes a shell command in the local workspace directory, returning the stdout, stderr, and exit code.",
					parameters: {
						type: "OBJECT",
						properties: {
							command: {
								type: "STRING",
								description: "The exact shell command to execute."
							}
						},
						required: ["command"]
					},
					...(nonBlockingEnabled ? { behavior: Behavior.NON_BLOCKING } : {}),
				},
				{
					name: "switch_session",
					description: "Selects one OMPK session or agent for this live connection by exact id, path, name, alias, or an unambiguous fragment. Selection does not resume or mutate the target.",
					parameters: {
						type: "OBJECT",
						properties: {
							name: {
								type: "STRING",
								description: "The name, alias, or session path to switch to."
							}
						},
						required: ["name"]
					}
				},
				{
					name: "get_session_info",
					description: "Gets information about the active session, available sessions, running session snapshots, and current working directory.",
					parameters: {
						type: "OBJECT",
						properties: {}
					}
				},
				{
					name: "get_realtime_capabilities",
					description: "Reports the actual selected live backend and which audio, camera, session, agent, and tool features are available on this connection.",
					parameters: { type: "OBJECT", properties: {} }
				},
				{
					name: "list_sessions",
					description: "Lists all sessions grouped by workspace (working directory), including which are stale or archived. Use to answer 'what sessions/workspaces do I have'.",
					parameters: {
						type: "OBJECT",
						properties: {}
					}
				},
				{
					name: "launch_agent",
					description: "Launches a new oh-my-pk background agent, opens the agent hub, or starts the Colab deployment flow when targetNode is 'colab'. Your prompt is distilled into a structured task packet before the agent sees it; a vague or low-confidence prompt comes back as a clarification instead of launching. Actually launching (as opposed to just opening the hub) mutates state, so it requires operator approval.",
					parameters: {
						type: "OBJECT",
						properties: {
							prompt: { type: "STRING", description: "Optional task prompt for the new agent. Omit to open the agent hub." },
							cwd: { type: "STRING", description: "Optional working directory for the agent." },
							hubOnly: { type: "BOOLEAN", description: "If true, just open the agent hub instead of launching a prompted agent." },
							targetNode: { type: "STRING", description: "Optional launch target. Use 'colab' to deploy the workspace to Colab." }
						}
					},
					...(nonBlockingEnabled ? { behavior: Behavior.NON_BLOCKING } : {}),
				},
				{
					name: "resume_session",
					description: "Resumes a saved OMPK session selected with switch_session, or a named target supplied explicitly. Requires operator approval.",
					parameters: {
						type: "OBJECT",
						properties: { target: { type: "STRING", description: "Optional session id, path, name, or alias. Defaults to the connection-local selection." } }
					}
				},
				{
					name: "send_session_message",
					description: "Sends a task or follow-up message to a selected OMPK session/background agent and returns its real response. Requires operator approval.",
					parameters: {
						type: "OBJECT",
						properties: {
							text: { type: "STRING", description: "The exact message or task to send." },
							target: { type: "STRING", description: "Optional id, path, name, or alias. Defaults to the connection-local selection." }
						},
						required: ["text"]
					}
				},
				{
					name: "kill_agent",
					description: "Stops/archives one active OMPK Agent Hub agent by exact id. Requires operator approval.",
					parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] }
				},
				{
					name: "revive_agent",
					description: "Revives one archived OMPK Agent Hub agent by exact id when the live binding supports recovery. Requires operator approval.",
					parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] }
				},
				{
					name: "archive_session",
					description: "Archives or recovers a session by its path. Archived sessions are hidden from the dashboard but fully recoverable. Mutates state, so it requires operator approval.",
					parameters: {
						type: "OBJECT",
						properties: {
							sessionPath: { type: "STRING", description: "The full session path to archive or recover." },
							action: { type: "STRING", description: "Either 'archive' or 'recover'." }
						},
						required: ["sessionPath", "action"]
					}
				},
				{
					name: "list_agent_hub_agents",
					description: "Read-only: lists all oh-my-pk background agents (main lanes and subagents) with their status. Use to answer 'what agents are running' or before proposing to launch/archive anything.",
					parameters: {
						type: "OBJECT",
						properties: {}
					}
				},
				{
					name: "get_agent_hub_agent",
					description: "Read-only: gets full detail plus a transcript tail for one background agent by id.",
					parameters: {
						type: "OBJECT",
						properties: {
							id: { type: "STRING", description: "The agent id, as returned by list_agent_hub_agents." },
							tailLines: { type: "NUMBER", description: "How many trailing transcript lines to include (default 40, max 500)." }
						},
						required: ["id"]
					}
				},
				{
					name: "browse_workspace",
					description: "Read-only: lists directories and files at a path within the workspace root, for inspecting the codebase.",
					parameters: {
						type: "OBJECT",
						properties: {
							path: { type: "STRING", description: "Absolute path to list. Omit to list the workspace root." }
						}
					}
				},
				{
					name: "read_workspace_file",
					description: "Read-only: reads a text file's content (capped at 512KB) within the workspace root.",
					parameters: {
						type: "OBJECT",
						properties: {
							path: { type: "STRING", description: "Absolute path of the file to read." }
						},
						required: ["path"]
					}
				},
				{
					name: "web_search",
					description: "Read-only: search the public web for up-to-date facts. Returns a short answer box when available plus top result titles, snippets, and links. Use for current events, docs, or anything outside the local workspace.",
					parameters: {
						type: "OBJECT",
						properties: {
							query: { type: "STRING", description: "The search query." }
						},
						required: ["query"]
					}
				},
				{
					name: "camera_snapshot",
					description: "Look through the operator's webcam. Requests one JPEG frame from the connected client so you can describe or answer questions about what they are showing. Only works while a live client with camera access is connected.",
					parameters: {
						type: "OBJECT",
						properties: {
							reason: { type: "STRING", description: "Optional short reason shown to the operator while the frame is captured." }
						}
					}
				}
			]
		}
	];
}

async function startNewSession(
	ws: WebSocket,
	server: any,
	firstMsg?: any,
	firstMsgIsBinary?: boolean,
	reconnect?: ReconnectContext,
) {
	const sessionId = reconnect?.priorSessionId || ("sess_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 5));
	const resumptionHandle = reconnect?.resumptionHandle;

	const liveBackendKind = resolveLiveBackendKind();
	let model: string;
	let clientConfig: ReturnType<typeof createGeminiClient> | undefined;
	if (liveBackendKind === "gemini") {
		try {
			model = getGeminiLiveModel();
			clientConfig = createGeminiClient(process.env, { live: true });
		} catch (error: any) {
			ws.close(1011, `Failed to initialize Gemini Live client: ${error?.message ?? String(error)}`);
			return;
		}
	} else {
		model = process.env.PI_SPEAK_OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";
	}
	// NON_BLOCKING function behavior is a Gemini Developer API capability.
	const nonBlockingEnabled = liveBackendKind === "gemini" && clientConfig?.backend === "developer-api";

	const activeSession: ActiveSession = reconnect?.activeSession ?? {
		reconnectToken: randomUUID(),
		sessionId,
		ws,
		session: null,
		clientSequenceId: 0,
		serverSequenceId: 0,
		pendingServerMessages: [],
		upstreamSetupComplete: false,
		clientHandlersReady: false,
		startSent: false,
		reconnectingUpstream: false,
		server,
		terminalApprovals: createRealtimeTerminalApprovalRegistry(),
		pendingTerminalCalls: new Map(),
		commandApprovals: createRealtimeCommandApprovalRegistry(),
		pendingCommandCalls: new Map(),
		pendingCameraCalls: new Map(),
		provider: liveBackendKind,
		model,
		backend: liveBackendKind === "gemini" ? (clientConfig?.backend || "developer-api") : "openai-realtime",
		nonBlockingEnabled,
		resumptionHandle: liveBackendKind === "gemini" ? resumptionHandle : undefined,
		cwd: reconnect?.cwd,
		outputAudioRate: 24_000,
		upstreamGeneration: 0,
		pendingToolResponses: reconnect?.pendingToolResponses ?? [],
		liveBackendKind,
	};
	if (reconnect?.activeSession) {
		Object.assign(activeSession, {
			provider: liveBackendKind,
			model,
			backend: liveBackendKind === "gemini" ? (clientConfig?.backend || "developer-api") : "openai-realtime",
			nonBlockingEnabled,
			resumptionHandle: liveBackendKind === "gemini" ? resumptionHandle : undefined,
			pendingToolResponses: reconnect.pendingToolResponses,
			liveBackendKind,
			upstreamSetupComplete: false,
			startSent: false,
		});
	}
	activeSessions.set(sessionId, activeSession);


	const upstreamGeneration = ++activeSession.upstreamGeneration;
	const tools = buildRealtimeTools(nonBlockingEnabled);

	try {
		if (liveBackendKind === "openai-realtime") {
			if (!isOpenAiRealtimeLiveConfigured()) {
				throw new Error(
					"OpenAI Realtime / HF S2S backend selected but PI_SPEAK_OPENAI_REALTIME_URL (or SPEECH_TO_SPEECH_URL) is not set.",
				);
			}
			const connectUrl = resolveOpenAiRealtimeConnectUrl();
			const backendSession = await connectOpenAiRealtimeLive(
				{
					connectUrl,
					apiKey: process.env.PI_SPEAK_OPENAI_REALTIME_KEY || process.env.OPENAI_API_KEY || undefined,
					voice: process.env.PI_SPEAK_OPENAI_REALTIME_VOICE || undefined,
					inputSampleRate: Number.parseInt(process.env.PI_SPEAK_OPENAI_REALTIME_INPUT_RATE || "24000", 10),
					inputTranscriptionModel: resolveOpenAiInputTranscriptionModel(),
					instructions: process.env.PI_SPEAK_GEMINI_SYSTEM_PROMPT || REALTIME_SYSTEM_PROMPT,
				},
				{
					systemInstruction: process.env.PI_SPEAK_GEMINI_SYSTEM_PROMPT || REALTIME_SYSTEM_PROMPT,
					tools,
				},
				{
					onOutbound: (event) => {
						if (upstreamGeneration !== activeSession.upstreamGeneration) return;
						if (event.kind === "audio") {
							if (event.sampleRate !== activeSession.outputAudioRate) {
								activeSession.outputAudioRate = event.sampleRate;
								sendToClient(activeSession, { type: "audio_format", rate: event.sampleRate }, false);
							}
							sendToClient(activeSession, event.pcm, true);
						} else if (event.kind === "transcript") {
							if (event.text) sendToClient(activeSession, { type: "transcript", text: event.text, role: event.role }, false);
							if (event.final) sendToClient(activeSession, { type: "transcript_complete", role: event.role }, false);
						} else if (event.kind === "interrupt") {
							sendToClient(activeSession, { type: "interrupt" }, false);
						} else if (event.kind === "error") {
							sendToClient(activeSession, { type: "error", message: event.message }, false);
						} else if (event.kind === "tool_call") {
							void (async () => {
								const toolCall = { id: event.id, name: event.name };
								const commandArg = typeof event.args.command === "string" ? event.args.command : undefined;
								sendToClient(activeSession, {
									type: "tool_start",
									name: event.name,
									command: commandArg,
								}, false);
								const { deferToolResponse, outputText } = await dispatchRealtimeToolCall(
									activeSession,
									toolCall,
									event.args,
								);
								if (!deferToolResponse) {
									sendRealtimeToolResponse(activeSession, toolCall, outputText);
								}
							})();
						} else if (event.kind === "status" && event.status === "ready") {
							activeSession.upstreamSetupComplete = true;
							activeSession.reconnectingUpstream = false;
							if (activeSession.pendingToolResponses.length > 0 && activeSession.liveBackendSession?.sendToolResult) {
								const queued = activeSession.pendingToolResponses.splice(0);
								for (const fr of queued) {
									const id = typeof fr.id === "string" ? fr.id : "";
									const name = typeof fr.name === "string" ? fr.name : "";
									if (!id || !name) continue;
									const response = fr.response;
									const output = response && typeof response === "object" && "output" in response
										? String((response as { output?: unknown }).output ?? "")
										: JSON.stringify(response ?? {});
									try {
									if (!activeSession.liveBackendSession.sendToolResult(id, name, output)) {
										activeSession.pendingToolResponses.push(fr);
									}
									} catch {
										activeSession.pendingToolResponses.push(fr);
									}
								}
							}
							sendLiveStartWhenReady(activeSession);
						} else if (event.kind === "status" && event.status === "closed" && !activeSession.reconnectingUpstream) {
							activeSessions.delete(activeSession.sessionId);
							sendToClient(activeSession, { type: "error", message: "Realtime upstream closed; reconnect the live client." }, false);
							if (activeSession.ws.readyState === WebSocket.OPEN) activeSession.ws.close(1011, "Realtime upstream closed");
						}
					},
				},
			);
			activeSession.liveBackendSession = backendSession;
			// Clear any Gemini-only resumption handle — OpenAI/HF has no equivalent.
			activeSession.resumptionHandle = undefined;
			// Duck-type enough of the Gemini session surface used by setupSocketHandlers / close.
			activeSession.session = {
				sendRealtimeInput: (payload: { media?: { data?: string }; activityStart?: object }) => {
					if (payload?.media?.data) {
						backendSession.sendAudio({ pcm: Buffer.from(payload.media.data, "base64"), sampleRate: 16000 });
					}
					if (payload && "activityStart" in payload) backendSession.interrupt();
				},
				sendClientContent: (payload: { turns?: Array<{ parts?: Array<{ text?: string }> }> }) => {
					const text = payload?.turns?.[0]?.parts?.find((p) => p.text)?.text;
					if (text) backendSession.sendText(text);
				},
				sendToolResponse: (payload: { functionResponses?: Array<{ id?: string; name?: string; response?: unknown }> }) => {
					for (const fr of payload.functionResponses || []) {
						if (!fr.id || !fr.name) continue;
						const output = typeof fr.response === "object" && fr.response && "output" in (fr.response as object)
							? String((fr.response as { output?: unknown }).output ?? "")
							: JSON.stringify(fr.response ?? {});
						backendSession.sendToolResult?.(fr.id, fr.name, output);
					}
				},
				close: () => backendSession.close(),
			};
			// Do NOT mark upstreamSetupComplete until session.created/updated → status ready.
			// sendLiveStartWhenReady is invoked from onOutbound status=ready.
			setupSocketHandlers(activeSession);
			// Wire OpenAI tool calls into the same dispatch as Gemini by handling on the client socket message path is awkward;
			// process tool calls inline here via a dedicated listener.
			if (firstMsg !== undefined) ws.emit("message", firstMsg, firstMsgIsBinary);
			if (activeSession.configurationError) {
				activeSessions.delete(sessionId);
				try { backendSession.close(); } catch {}
				ws.close(1008, activeSession.configurationError);
				return;
			}
			activeSession.clientHandlersReady = true;
			sendLiveStartWhenReady(activeSession);
			return;
		}

		const geminiSession = await clientConfig!.ai.live.connect({
			model,
			config: {
				responseModalities: [Modality.AUDIO],
				outputAudioTranscription: {},
				inputAudioTranscription: {},
				systemInstruction: process.env.PI_SPEAK_GEMINI_SYSTEM_PROMPT || REALTIME_SYSTEM_PROMPT,
				tools: tools as any,
				// Keep long coding sessions alive: compress context before the ~128k
				// audio-token cap, and enable resumption handles so we can reconnect
				// across the ~10-min WS limit / goAway without losing the conversation.
				contextWindowCompression: {
					triggerTokens: "24000",
					slidingWindow: { targetTokens: "16000" },
				},
				sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
			},
			callbacks: {
				onopen: () => {
					// Connection opened
				},
				onmessage: async (message: LiveServerMessage) => {
					if (upstreamGeneration !== activeSession.upstreamGeneration) return;
					if (message.setupComplete) {
						activeSession.upstreamSetupComplete = true;
						sendLiveStartWhenReady(activeSession);
					}

					// 1. Forward raw audio chunk
					for (const part of message.serverContent?.modelTurn?.parts || []) {
						if (part.inlineData?.data) {
							const audioBuf = Buffer.from(part.inlineData.data, "base64");
							sendToClient(activeSession, audioBuf, true);
						}
					}

					// 2. Forward role-aware input and output transcript updates.
					const inputText = message.serverContent?.inputTranscription?.text;
					if (inputText) {
						sendToClient(activeSession, { type: "transcript", text: inputText, role: "user" }, false);
					}
					if (message.serverContent?.inputTranscription?.finished) {
						sendToClient(activeSession, { type: "transcript_complete", role: "user" }, false);
					}
					const text = extractText(message);
					if (text) {
						sendToClient(activeSession, {
							type: "transcript",
							text,
							role: "assistant",
						}, false);
					}
					const outputTranscription = message.serverContent?.outputTranscription;
					if (outputTranscription?.finished || (!outputTranscription && message.serverContent?.turnComplete)) {
						sendToClient(activeSession, { type: "transcript_complete", role: "assistant" }, false);
					}

					// 3. Handle model interruption/barge-in signal from server
					if (message.serverContent?.interrupted) {
						sendToClient(activeSession, {
							type: "interrupt"
						}, false);
					}

					// 3b. Cache resumption handle for reconnection across the WS limit.
					if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
						activeSession.resumptionHandle = message.sessionResumptionUpdate.newHandle;
					}

					// 3c. goAway: server will terminate the WS (~10-min limit) ~60s out.
					// Proactively reconnect with the cached handle; in-flight NON_BLOCKING
					// results queue in pendingToolResponses and flush after reconnect.
					if (message.goAway) {
						sendToClient(activeSession, { type: "reconnecting", timeLeft: message.goAway.timeLeft }, false);
						reconnectLiveSession(activeSession).catch((err) => {
							sendToClient(activeSession, { type: "error", message: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}` }, false);
							try { activeSession.ws.close(1011, "Reconnect failed"); } catch {}
						});
					}

					// 4. Handle Tool calls
					if (message.toolCall?.functionCalls) {
						for (const call of message.toolCall.functionCalls) {
							if (!call.name || !call.id) continue;
							const toolCall = { id: call.id, name: call.name };
							const args = (call.args && typeof call.args === "object")
								? call.args as Record<string, unknown>
								: {};
							const commandArg = typeof args.command === "string" ? args.command : undefined;
							sendToClient(activeSession, {
								type: "tool_start",
								name: call.name,
								command: commandArg,
							}, false);
							const { deferToolResponse, outputText } = await dispatchRealtimeToolCall(activeSession, toolCall, args);
							if (deferToolResponse) continue;
							sendRealtimeToolResponse(activeSession, toolCall, outputText);
						}
					}
				},
				onerror: (event) => {
					if (upstreamGeneration !== activeSession.upstreamGeneration) return;
					sendToClient(activeSession, {
						type: "error",
						message: event.error?.message || event.message || "Gemini Live error",
					}, false);
				},
				onclose: (event) => {
					if (upstreamGeneration !== activeSession.upstreamGeneration) return;
					activeSessions.delete(activeSession.sessionId);
					if (activeSession.ws.readyState === WebSocket.OPEN) {
						activeSession.ws.close(event.code || 1000, event.reason || "Gemini Live closed connection");
					}
				}
			}
		});
		activeSession.session = geminiSession;

		// Deliver any FunctionResponses that completed while we were reconnecting.
		if (activeSession.pendingToolResponses.length > 0) {
			const queued = activeSession.pendingToolResponses.splice(0);
			for (const functionResponse of queued) {
				try {
					geminiSession.sendToolResponse({ functionResponses: [functionResponse] });
				} catch {
					activeSession.pendingToolResponses.push(functionResponse);
				}
			}
		}

		setupSocketHandlers(activeSession);

		if (firstMsg !== undefined) {
			ws.emit("message", firstMsg, firstMsgIsBinary);
		}
		if (activeSession.configurationError) {
			activeSessions.delete(sessionId);
			try { geminiSession.close(); } catch {}
			ws.close(1008, activeSession.configurationError);
			return;
		}

		activeSession.clientHandlersReady = true;
		sendLiveStartWhenReady(activeSession);
	} catch (error: any) {
		activeSessions.delete(sessionId);
		ws.close(1011, `Failed to connect to Gemini Live: ${error.message}`);
	}
}

// Reconnect the upstream Gemini Live session (same client WS) using the cached
// resumption handle, carrying the pending-tool-response queue so results that
// land mid-reconnect still deliver. The client WS is untouched.
async function reconnectLiveSession(activeSession: ActiveSession) {
	const ws = activeSession.ws;
	const server = activeSession.server;
	const kind = activeSession.liveBackendKind || resolveLiveBackendKind();
	// OpenAI-Realtime / HF S2S has no Gemini-style resumption handle. Always do a
	// clean upstream re-connect on the same client WS, preserving pending tool
	// responses and cwd, but never passing a Gemini handle into the OpenAI path.
	const reconnect: ReconnectContext = {
		resumptionHandle: kind === "openai-realtime" ? undefined : activeSession.resumptionHandle,
		pendingToolResponses: activeSession.pendingToolResponses,
		priorSessionId: activeSession.sessionId,
		cwd: activeSession.cwd,
		activeSession,
	};
	activeSession.reconnectingUpstream = true;
	try {
		activeSession.liveBackendSession?.close();
	} catch {}
	activeSession.liveBackendSession = undefined;
	try {
		activeSession.session?.close();
	} catch {}
	activeSession.session = null;
	activeSession.upstreamSetupComplete = false;
	activeSession.startSent = false;
	if (kind === "openai-realtime") {
		sendToClient(activeSession, {
			type: "reconnecting",
			message: "OpenAI-Realtime/HF backend does not support mid-call Gemini resumption; reconnecting cleanly.",
		}, false);
	}
	await startNewSession(ws, server, undefined, undefined, reconnect);
}

function resumeSession(ws: WebSocket, reconnectMsg: RealtimeControlMessage) {
	const sessionId = reconnectMsg.session!;
	const activeSession = activeSessions.get(sessionId);
	if (!activeSession || reconnectMsg.reconnectToken !== activeSession.reconnectToken) {
		ws.close(1008, "Invalid live reconnect token");
		return;
	}
	const supersededSocket = activeSession.ws;
	activeSession.reconnectToken = randomUUID();

	if (activeSession.disconnectTimeout) {
		clearTimeout(activeSession.disconnectTimeout);
		activeSession.disconnectTimeout = undefined;
	}

	activeSession.ws = ws;
	if (supersededSocket !== ws && supersededSocket.readyState === WebSocket.OPEN) {
		supersededSocket.close(1000, "Live session resumed on another socket");
	}
	setupSocketHandlers(activeSession);

	// Flush pending/buffered server messages that client has not yet received
	const lastClientReceived = reconnectMsg.serverSequenceId || 0;
	flushPendingServerMessages(activeSession, lastClientReceived);
	sendToClient(activeSession, { type: "start", session: sessionId, reconnectToken: activeSession.reconnectToken }, false);
}

export async function handleRealtimeGateway(this: any, ws: WebSocket) {
	const server = this;

	let initialized = false;
	const initTimeout = setTimeout(() => {
		if (!initialized) {
			initialized = true;
			startNewSession(ws, server).catch(err => {
				ws.close(1011, `Failed to start session: ${err.message}`);
			});
		}
	}, 500);

	ws.once("message", (rawMsg, isBinary) => {
		if (initialized) return;
		clearTimeout(initTimeout);
		initialized = true;

		if (!isBinary) {
			try {
				const ctrl = JSON.parse(rawMsg.toString("utf8")) as RealtimeControlMessage;
				if (ctrl.type === "reconnect" && ctrl.session && activeSessions.has(ctrl.session)) {
					resumeSession(ws, ctrl);
					return;
				}
			} catch (err) {
				// Ignore
			}
		}

		startNewSession(ws, server, rawMsg, isBinary).catch(err => {
			ws.close(1011, `Failed to start session: ${err.message}`);
		});
	});
}

function extractText(message: LiveServerMessage): string {
	let text = "";
	const transcript = message.serverContent?.outputTranscription?.text;
	if (typeof transcript === "string") text += transcript;
	for (const part of message.serverContent?.modelTurn?.parts || []) {
		if (typeof part.text === "string") text += part.text;
	}
	return text;
}

function findSessionNameByPath(sessionPath: string, sessions: Record<string, string>) {
	for (const [name, path] of Object.entries(sessions)) {
		if (path === sessionPath) return name;
	}
	return undefined;
}
