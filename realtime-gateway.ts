import { WebSocket } from "ws";
import { Behavior, FunctionResponseScheduling, GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";
import { createGeminiClient, getGeminiLiveModel } from "./gemini-live-turn.js";
import { readAttentionSnapshots, readAttentionLeaderLease, claimAttentionLeader } from "./attention-broker.js";
import { readSessionWorkingDirectory } from "./session-working-directory.js";
import { loadPersistedSessionRouting } from "./session-routing-store.js";
import { discoverAgentInventoryCached } from "./agent-discovery.js";
import { buildAgentResumeArgs, isResumableAgentSession } from "./agent-provider-registry.js";
import { resolveAgentProviderConfig } from "./agent-provider.js";
import { resolveWindowsNpmShim } from "./agent-discovery.js";
import { normalizeOptionalString } from "./agent-hub-actions.js";
import { safeSpawn } from "./spawn-shim.js";
import { spawn } from "node:child_process";
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
import { parseHubAgentId } from "./herdr-agent-hub-schema.js";

// Helper to resolve current cwd of the active session
function getCurrentCwd(): string {
	const lease = readAttentionLeaderLease();
	if (lease?.ownerSessionId) {
		const snapshots = readAttentionSnapshots();
		const activeSnapshot = snapshots.find(s => s.sessionId === lease.ownerSessionId);
		if (activeSnapshot?.sessionPath) {
			const cwd = readSessionWorkingDirectory(activeSnapshot.sessionPath);
			if (cwd) return cwd;
		}
	}
	const snapshots = readAttentionSnapshots();
	if (snapshots.length > 0 && snapshots[0].sessionPath) {
		const cwd = readSessionWorkingDirectory(snapshots[0].sessionPath);
		if (cwd) return cwd;
	}
	return process.cwd();
}

function resolveResumeExecutable(provider: string | undefined) {
	const normalized = provider?.trim().toLowerCase();
	if (normalized === "codex") {
		return resolveAgentProviderConfig(process.env).codexBin;
	}
	if (normalized === "claude") {
		return process.env.CLAUDE_BIN || resolveWindowsNpmShim("claude.cmd") || "claude";
	}
	return undefined;
}

function launchDetachedCli(command: string, args: string[], cwd: string, title: string) {
	if (process.platform === "win32") {
		const child = spawn("cmd.exe", ["/c", "start", title, "/D", cwd, command, ...args], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} else {
		const child = spawn(command, args, {
			cwd,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
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
	session: any; // Gemini Live session
	clientSequenceId: number; // last processed client sequence ID
	serverSequenceId: number; // last assigned server sequence ID
	disconnectTimeout?: NodeJS.Timeout;
	pendingServerMessages: { seqId: number; isBinary: boolean; data: any }[];
	terminalApprovals: RealtimeTerminalApprovalRegistry;
	pendingTerminalCalls: Map<string, PendingTerminalCall>;
	commandApprovals: RealtimeCommandApprovalRegistry;
	pendingCommandCalls: Map<string, PendingCommandCall>;
	provider: string;
	model: string;
	server: any; // store server reference
	/** Backend of the Live connection ("developer-api" | "vertex"). */
	backend: string;
	/** True when NON_BLOCKING async function calling is available (developer-api only). */
	nonBlockingEnabled: boolean;
	/** Latest session-resumption handle from sessionResumptionUpdate. */
	resumptionHandle?: string;
	/** FunctionResponses queued while the session is mid-reconnect. */
	pendingToolResponses: Record<string, unknown>[];
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
	"You are a conversational assistant with full read access to this workspace: sessions, background agents, and the filesystem.",
	"Use your read-only tools (list_sessions, get_session_info, list_agent_hub_agents, get_agent_hub_agent, browse_workspace, read_workspace_file) freely and proactively to understand the real state before answering — never guess.",
	"When a request is ambiguous or could mean more than one thing, ask a short clarifying question before acting instead of assuming.",
	"Mutating actions — launching a background agent, archiving or recovering a session, or running a terminal command outside the read-only allowlist — always require the operator's explicit approval. Call the tool normally; if the result says it requires confirmation, tell the user what you are about to do and wait for them to approve or reject it before treating it as done.",
	"Never claim an action completed until you receive a real tool result confirming it.",
	"When you fire a background tool (launch_agent, execute_terminal_command), acknowledge in one short sentence, then continue the conversation normally.",
	"Do not narrate a tool's progress unless you receive an explicit progress update.",
	"When a tool result arrives, announce it conversationally at the next natural pause.",
	"Do not narrate background state refreshes delivered silently.",
	"Keep replies short and conversational.",
].join(" ");

export { classifyRealtimeTerminalCommand, type RealtimeTerminalCommandSafety };

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
	const cwd = getCurrentCwd();
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
	sendToClient(activeSession, {
		type: "tool_complete",
		name: call.name,
		approvalId: opts.approvalId,
		output: outputText,
		willContinue: opts.willContinue,
	}, false);

	const functionResponse: Record<string, unknown> = {
		id: call.id,
		name: call.name,
		response: opts.response ?? { output: outputText },
	};
	// scheduling/willContinue are only meaningful for NON_BLOCKING calls; harmless
	// (ignored) otherwise per the @google/genai FunctionResponse contract.
	if (opts.scheduling !== undefined) functionResponse.scheduling = opts.scheduling;
	if (opts.willContinue !== undefined) functionResponse.willContinue = opts.willContinue;

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
		cwd: getCurrentCwd(),
		approved,
		decision: reason,
	});
	sendToClient(activeSession, {
		type: "tool_approval_resolved",
		approvalId: approval.id,
		name: pending.call.name,
		command: pending.plan.command,
		cwd: getCurrentCwd(),
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
				cwd: getCurrentCwd(),
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
			cwd: getCurrentCwd(),
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
	const cwd = (args.cwd as string | undefined) || getCurrentCwd();
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
	if (activeSession.server && typeof activeSession.server.onSessionArchive === "function") {
		const result = await activeSession.server.onSessionArchive({ sessionPath, action });
		return JSON.stringify(result);
	}
	return JSON.stringify({ ok: false, error: "Session archive is not available." });
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
		outputText = pending.kind === "launch_agent"
			? await executeLaunchAgentMutation(activeSession, pending.call, args)
			: await executeArchiveSessionMutation(activeSession, args);
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

function setupSocketHandlers(activeSession: ActiveSession) {
	const ws = activeSession.ws;
	
	ws.on("message", (rawMsg, isBinary) => {
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
					if (activeSession.session) {
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
					if (activeSession.session) {
						activeSession.session.sendRealtimeInput({ activityStart: {} });
					}
					// Echo interrupt back to client to clear buffers immediately
					sendToClient(activeSession, { type: "interrupt" }, false);
				} else if (ctrl.type === "text" && ctrl.text) {
					// Text turn from client
					if (activeSession.session) {
						activeSession.session.sendClientContent({
							turns: [{ role: "user", parts: [{ text: ctrl.text }] }],
							turnComplete: true,
						});
					}
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
};

// Extracted (rather than inlined in startNewSession) so the tool surface —
// what the assistant can read freely vs. what requires operator approval —
// is unit-testable independently of a live Gemini Live connection.
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
					description: "Resumes or switches the active workspace session to the specified session name, alias, or path.",
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
					name: "list_sessions",
					description: "Lists all sessions grouped by workspace (working directory), including which are stale or archived. Use to answer 'what sessions/workspaces do I have'.",
					parameters: {
						type: "OBJECT",
						properties: {}
					}
				},
				{
					name: "launch_agent",
					description: "Launches a new oh-my-pk background agent, opens the agent hub, or starts the Colab deployment flow when targetNode is 'colab'. Actually launching (as opposed to just opening the hub) mutates state, so it requires operator approval.",
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

	// Resolve the model + client before touching session state. These can throw
	// synchronously (bad config / missing credentials); catching here prevents an
	// unhandled rejection from crashing the whole gateway process.
	let model: string;
	let clientConfig: ReturnType<typeof createGeminiClient>;
	try {
		model = getGeminiLiveModel();
		clientConfig = createGeminiClient(process.env, { live: true });
	} catch (error: any) {
		ws.close(1011, `Failed to initialize Gemini Live client: ${error?.message ?? String(error)}`);
		return;
	}
	const ai = clientConfig.ai;
	// NON_BLOCKING function behavior is developer-API only (not supported on Vertex
	// AI per the @google/genai FunctionDeclaration contract). On Vertex we keep the
	// existing blocking dispatch so tool calls still resolve correctly.
	const nonBlockingEnabled = clientConfig.backend === "developer-api";

	const activeSession: ActiveSession = {
		sessionId,
		ws,
		session: null,
		clientSequenceId: 0,
		serverSequenceId: 0,
		pendingServerMessages: [],
		server,
		terminalApprovals: createRealtimeTerminalApprovalRegistry(),
		pendingTerminalCalls: new Map(),
		commandApprovals: createRealtimeCommandApprovalRegistry(),
		pendingCommandCalls: new Map(),
		provider: process.env.AGENT_PROVIDER || "gemini-live",
		model,
		backend: clientConfig.backend,
		nonBlockingEnabled,
		resumptionHandle,
		pendingToolResponses: reconnect?.pendingToolResponses ?? [],
	};
	activeSessions.set(sessionId, activeSession);

	// Send start message with sessionId. We want this to be serverSequenceId = 1.
	sendToClient(activeSession, {
		type: "start",
		session: sessionId
	}, false);

	const tools = buildRealtimeTools(nonBlockingEnabled);

	try {
		const geminiSession = await ai.live.connect({
			model,
			config: {
				responseModalities: [Modality.AUDIO],
				outputAudioTranscription: {},
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
					// 1. Forward raw audio chunk
					for (const part of message.serverContent?.modelTurn?.parts || []) {
						if (part.inlineData?.data) {
							const audioBuf = Buffer.from(part.inlineData.data, "base64");
							sendToClient(activeSession, audioBuf, true);
						}
					}

					// 2. Forward transcript text updates
					const text = extractText(message);
					if (text) {
						sendToClient(activeSession, {
							type: "transcript",
							text,
						}, false);
					}
					const outputTranscription = message.serverContent?.outputTranscription;
					if (outputTranscription?.finished || (!outputTranscription && message.serverContent?.turnComplete)) {
						sendToClient(activeSession, { type: "transcript_complete" }, false);
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
							let deferToolResponse = false;
							
							// Send tool_start event
							sendToClient(activeSession, {
								type: "tool_start",
								name: call.name,
								command: call.args?.command as string || undefined,
							}, false);

							let outputText = "";
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
											cwd: getCurrentCwd(),
										});
										appendTerminalAudit(activeSession, {
											kind: "terminal.execution_result",
											toolCallId: toolCall.id,
											command: "",
											action: "requires_confirmation",
											reason: "missing-command",
											cwd: getCurrentCwd(),
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
											cwd: getCurrentCwd(),
										});
										if (plan.action !== "allow") {
											outputText = JSON.stringify({
												ok: false,
												requiresConfirmation: true,
												reason: plan.reason,
												command,
												cwd: getCurrentCwd(),
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
												cwd: getCurrentCwd(),
											});
											sendToClient(activeSession, {
												type: "tool_approval_required",
												approvalId: approval.id,
												name: call.name,
												command,
												cwd: getCurrentCwd(),
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
									const name = call.args?.name as string;
									if (!name) {
										outputText = JSON.stringify({ ok: false, error: "Missing 'name' argument" });
									} else {
										const persisted = loadPersistedSessionRouting();
										
										// Find matching sessionPath
										let matchedPath: string | undefined;
										let matchedName: string | undefined;
										
										// 1. Match directly by name in registry
										for (const [sName, sPath] of Object.entries(persisted.sessions)) {
											if (sName.toLowerCase() === name.toLowerCase()) {
												matchedPath = sPath;
												matchedName = sName;
												break;
											}
										}
										// 2. Match by alias
										if (!matchedPath) {
											for (const [alias, sPath] of Object.entries(persisted.aliases)) {
												if (alias.toLowerCase() === name.toLowerCase()) {
													matchedPath = sPath;
													matchedName = findSessionNameByPath(sPath, persisted.sessions) || alias;
													break;
												}
											}
										}
										// 3. Match by path substring or exact path
										if (!matchedPath) {
											for (const sPath of Object.values(persisted.sessions)) {
												if (sPath.toLowerCase() === name.toLowerCase() || sPath.toLowerCase().includes(name.toLowerCase())) {
													matchedPath = sPath;
													matchedName = findSessionNameByPath(sPath, persisted.sessions) || "path-match";
													break;
												}
											}
										}

										if (!matchedPath) {
											outputText = JSON.stringify({ ok: false, error: `Session not found: ${name}` });
										} else {
											// Check if running
											const snapshots = readAttentionSnapshots();
											const runningSession = snapshots.find(s => s.sessionPath === matchedPath);
											
											if (runningSession) {
												// Already running, claim leader lease
												claimAttentionLeader(runningSession.sessionId);
												// Update routing target
												if (activeSession.server && typeof activeSession.server.setRoutingTarget === "function") {
													await activeSession.server.setRoutingTarget(matchedName || matchedPath);
												}
												outputText = JSON.stringify({
													ok: true,
													message: `Switched routing target to active session: ${matchedName || matchedPath}`,
													sessionPath: matchedPath,
													sessionId: runningSession.sessionId,
													active: true,
												});
											} else {
												// Not running, resume it
												if (activeSession.server && typeof activeSession.server.onSessionResume === "function") {
													const resumeRes = await activeSession.server.onSessionResume({ sessionPath: matchedPath });
													outputText = JSON.stringify({
														ok: resumeRes.ok,
														message: resumeRes.message,
														sessionPath: matchedPath,
														active: false,
													});
												} else {
													// Fallback to manual launch
													const inventory = discoverAgentInventoryCached();
													const session = inventory.recent.find(s => s.path === matchedPath);
													if (session) {
														const executable = resolveResumeExecutable(session.provider);
														const args = buildAgentResumeArgs(session.provider, session.sessionId || "", session.cwd);
														if (executable && args) {
															launchDetachedCli(executable, args, session.cwd || process.cwd(), `${session.provider} resume`);
															outputText = JSON.stringify({
																ok: true,
																message: `Launching detached resume for ${session.provider} session.`,
																sessionPath: matchedPath,
																active: false,
															});
														} else {
															outputText = JSON.stringify({
																ok: false,
																error: `Unable to resume session: unsupported provider ${session.provider}`,
															});
														}
													} else {
														outputText = JSON.stringify({
															ok: false,
															error: "Session found in routing store but not in recent resume inventory.",
														});
													}
												}
											}
										}
									}
								} else if (call.name === "get_session_info") {
									const persisted = loadPersistedSessionRouting();
									const snapshots = readAttentionSnapshots();
									const lease = readAttentionLeaderLease();
									const cwd = getCurrentCwd();
									
									outputText = JSON.stringify({
										currentSession: lease?.ownerSessionId || "unknown",
										currentCwd: cwd,
										persistedSessions: persisted.sessions,
										persistedAliases: persisted.aliases,
										runningSnapshots: snapshots.map(s => ({
											sessionId: s.sessionId,
											sessionName: s.sessionName,
											sessionPath: s.sessionPath,
											pid: s.pid,
											phase: s.phase,
											waitingForAttention: s.waitingForAttention,
										})),
									});
								} else if (call.name === "list_sessions") {
									if (activeSession.server && typeof activeSession.server.getSessionDashboard === "function") {
										const dashboard = activeSession.server.getSessionDashboard();
										outputText = JSON.stringify({
											ok: true,
											current: dashboard.current,
											workspaces: (dashboard.workspaces || []).map((w: any) => ({
												workspace: w.workspace,
												sessions: w.sessions.map((s: any) => ({
													name: s.name,
													provider: s.provider,
													stale: !!s.stale,
													sessionPath: s.sessionPath,
												})),
											})),
										});
									} else {
										outputText = JSON.stringify({ ok: false, error: "Session dashboard is not available." });
									}
				} else if (call.name === "launch_agent") {
					const prompt = call.args?.prompt as string | undefined;
					const cwd = (call.args?.cwd as string | undefined) || getCurrentCwd();
					const hubOnly = call.args?.hubOnly as boolean | undefined;
					const targetNode = call.args?.targetNode as string | undefined;
					if (isNavigationalLaunch({ prompt, hubOnly, targetNode })) {
						// Navigational only (opens the hub/dashboard); nothing mutates, so no approval needed.
						if (activeSession.server && typeof activeSession.server.onSessionLaunch === "function") {
							const result = await activeSession.server.onSessionLaunch({ prompt, cwd, hubOnly: true, targetNode });
							outputText = JSON.stringify(result);
						} else {
							outputText = JSON.stringify({ ok: false, error: "Session launch is not available." });
						}
					} else {
						const description = targetNode
							? `Deploy this workspace to ${targetNode}.`
							: `Launch a new background agent in ${cwd}${prompt ? ` with prompt: "${prompt}"` : ""}.`;
						deferToolResponse = true;
						requestCommandApproval(activeSession, toolCall, { prompt, cwd, hubOnly, targetNode }, "launch_agent", description);
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
									if (activeSession.server?.agentHubGateway) {
										const snapshot = await activeSession.server.agentHubGateway.snapshot();
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
									} else if (activeSession.server?.agentHubGateway) {
										const detail = await activeSession.server.agentHubGateway.detail(id, Math.min(Math.max(tailLines, 1), 500));
										outputText = detail ? JSON.stringify({ ok: true, agent: detail }) : JSON.stringify({ ok: false, error: `Unknown agent: ${id}` });
									} else {
										outputText = JSON.stringify({ ok: false, error: "Agent hub is not available." });
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
								} else {
									outputText = JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
								}
							} catch (err: any) {
								outputText = JSON.stringify({ ok: false, error: err.message });
							}
							if (deferToolResponse) continue;

							sendRealtimeToolResponse(activeSession, toolCall, outputText);
						}
					}
				},
				onerror: (event) => {
					sendToClient(activeSession, {
						type: "error",
						message: event.error?.message || event.message || "Gemini Live error",
					}, false);
				},
				onclose: (event) => {
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
	const reconnect: ReconnectContext = {
		resumptionHandle: activeSession.resumptionHandle,
		pendingToolResponses: activeSession.pendingToolResponses,
		priorSessionId: activeSession.sessionId,
	};
	try {
		activeSession.session?.close();
	} catch {}
	activeSession.session = null;
	await startNewSession(ws, server, undefined, undefined, reconnect);
}

function resumeSession(ws: WebSocket, reconnectMsg: RealtimeControlMessage) {
	const sessionId = reconnectMsg.session!;
	const activeSession = activeSessions.get(sessionId)!;

	if (activeSession.disconnectTimeout) {
		clearTimeout(activeSession.disconnectTimeout);
		activeSession.disconnectTimeout = undefined;
	}

	activeSession.ws = ws;
	setupSocketHandlers(activeSession);

	// Flush pending/buffered server messages that client has not yet received
	const lastClientReceived = reconnectMsg.serverSequenceId || 0;
	flushPendingServerMessages(activeSession, lastClientReceived);
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
