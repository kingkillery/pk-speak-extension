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
	createRealtimeCommandApprovalRegistry,
	type RealtimeCommandApprovalRegistry,
} from "./realtime-command-approval.js";
import {
	buildRealtimeTerminalCommandPlan,
	classifyRealtimeTerminalCommand,
	executeRealtimeTerminalCommandPlan,
	type RealtimeTerminalCommandPlan,
	type RealtimeTerminalCommandSafety,
} from "./realtime-terminal-command.js";
import {
	appendRealtimeTerminalAuditEvent,
	buildRealtimeTerminalAuditResult,
	buildRealtimeTerminalPlanAuditFields,
} from "./realtime-terminal-audit.js";

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

type PendingCommandCall = {
	call: { id: string; name: string; args?: unknown };
	plan?: RealtimeTerminalCommandPlan;
	commandArgs?: Record<string, unknown>;
	timer?: ReturnType<typeof setTimeout>;
};

export const activeSessions = new Map<string, ActiveSession>();

// Voice-feel guidance: when a background tool runs (NON_BLOCKING), the model should
// acknowledge briefly and keep conversing instead of going silent, narrate progress
// only when it receives an update, and never narrate SILENT-scheduled updates.
export const REALTIME_SYSTEM_PROMPT = [
	"You are a conversational assistant that can see all subagent state and the workspace.",
	"Before taking any action that mutates a subagent, terminal, or file, interview the user to scope ambiguous requests and then ask for explicit approval.",
	"Use the propose_command tool when you want to run a mutating command; it returns a confirmation token and does not execute until the user approves.",
	"Keep replies short and conversational.",
	"When you fire a background tool (launch_agent, execute_terminal_command, etc.), acknowledge in one short sentence, then continue the conversation normally.",
	"Do not narrate a tool's progress unless you receive an explicit progress update.",
	"When a tool result arrives, announce it conversationally at the next natural pause.",
	"Do not narrate background state refreshes delivered silently.",
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

async function executeProposedCommand(
	activeSession: ActiveSession,
	pending: PendingCommandCall,
	approvalId?: string,
) {
	const args = pending.commandArgs ?? {};
	const callName = pending.call.name;
	const server = activeSession.server;
	try {
		if (callName === "execute_terminal_command" && pending.plan) {
			return await executeRealtimeTerminalCommand(activeSession, pending.plan, pending.call.id, approvalId);
		}
		if (callName === "launch_agent") {
			const prompt = args.prompt as string | undefined;
			const cwd = (args.cwd as string | undefined) || getCurrentCwd();
			const hubOnly = args.hubOnly as boolean | undefined;
			const targetNode = args.targetNode as string | undefined;
			if (server && typeof server.onSessionLaunch === "function") {
				return await server.onSessionLaunch({ prompt, cwd, hubOnly, targetNode });
			}
			return { ok: false, error: "Session launch is not available." };
		}
		if (callName === "archive_session") {
			const sessionPath = args.sessionPath as string;
			const action = args.action === "recover" ? "recover" : "archive";
			if (!sessionPath) return { ok: false, error: "Missing 'sessionPath' argument" };
			if (server && typeof server.onSessionArchive === "function") {
				return await server.onSessionArchive({ sessionPath, action });
			}
			return { ok: false, error: "Session archive is not available." };
		}
		if (callName === "chat_agent" || callName === "kill_agent") {
			const token = args.proposalToken as string | undefined;
			if (!token) return { ok: false, error: "Missing proposal token." };
			if (server && typeof server.agentHubExecute === "function") {
				return await server.agentHubExecute(token);
			}
			return { ok: false, error: "Agent hub execution is not available." };
		}
		if (callName === "propose_command") {
			const commandType = args.commandType as string;
			if (commandType === "execute_terminal_command" && pending.plan) {
				return await executeRealtimeTerminalCommand(activeSession, pending.plan, pending.call.id, approvalId);
			}
			if (commandType === "launch_agent" || commandType === "archive_session" || commandType === "chat" || commandType === "kill") {
				return await executeProposedCommand(activeSession, {
					...pending,
					call: { ...pending.call, name: commandType === "chat" ? "chat_agent" : commandType === "kill" ? "kill_agent" : commandType },
				}, approvalId);
			}
			return { ok: false, error: `Proposed command type not executable: ${commandType}` };
		}
		return { ok: false, error: `Unknown command: ${callName}` };
	} catch (err: any) {
		return { ok: false, error: err.message };
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

	if (pending.call.name === "execute_terminal_command" && pending.plan) {
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
		return;
	}

	sendToClient(activeSession, {
		type: "tool_approval_resolved",
		approvalId: approval.id,
		name: pending.call.name,
		command: approval.command,
		description: approval.description,
		message: approved ? "Command approved." : "Command rejected.",
	}, false);

	const outputText = approved
		? JSON.stringify(await executeProposedCommand(activeSession, pending, approval.id))
		: JSON.stringify({
			ok: false,
			rejected: true,
			requiresConfirmation: true,
			reason,
			command: approval.command,
			message: "Command was not approved by the operator.",
		});
	sendRealtimeToolResponse(activeSession, pending.call, outputText, { approvalId: approval.id, scheduling: FunctionResponseScheduling.INTERRUPT });
}

function stageCommandProposal(
	activeSession: ActiveSession,
	call: { id: string; name: string; args?: unknown },
	category: import("./realtime-command-approval.js").RealtimeCommandProposalCategory,
	command: string,
	description: string,
	args?: Record<string, unknown>,
	plan?: RealtimeTerminalCommandPlan,
) {
	const approval = activeSession.commandApprovals.request(category, command, description, args);
	const timeoutMs = Math.max(0, approval.expiresAt - Date.now());
	const timer = setTimeout(() => {
		resolveCommandApproval(activeSession, approval.id, false, "expired").catch((err) => {
			sendToClient(activeSession, { type: "error", message: `Command approval expiry failed: ${err instanceof Error ? err.message : String(err)}` }, false);
		});
	}, timeoutMs);
	timer.unref?.();
	activeSession.pendingCommandCalls.set(approval.id, {
		call: { ...call, args: call.args },
		plan,
		commandArgs: args,
		timer,
	});
	sendToClient(activeSession, {
		type: "tool_approval_required",
		approvalId: approval.id,
		name: call.name,
		command,
		description,
		message: "Confirm to run this command.",
	}, false);
	return JSON.stringify({
		ok: false,
		requiresConfirmation: true,
		approvalId: approval.id,
		command,
		description,
		expiresInMs: timeoutMs,
		message: "This command requires user approval.",
	});
}

async function prepareAgentHubProposal(
	activeSession: ActiveSession,
	action: "chat" | "kill",
	agentId: string,
	text?: string,
): Promise<{ ok: false; error: string } | { ok: true; token: string }> {
	if (!activeSession.server || typeof activeSession.server.agentHubPropose !== "function") {
		return { ok: false, error: "Agent hub proposal is not available." };
	}
	const result = await activeSession.server.agentHubPropose(action, agentId, text);
	if (result.ok && result.confirmToken) {
		return { ok: true, token: result.confirmToken };
	}
	return { ok: false, error: "result" in result && typeof result.error === "string" ? result.error : "Agent hub proposal was rejected." };
}

async function dispatchRealtimeToolCall(
	activeSession: ActiveSession,
	call: { id: string; name: string; args?: Record<string, unknown> },
): Promise<{ outputText: string; deferToolResponse: boolean }> {
	let outputText = "";
	let deferToolResponse = false;
	const server = activeSession.server;
	try {
		if (call.name === "execute_terminal_command") {
			const command = call.args?.command as string;
			if (!command) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'command' argument" });
				appendTerminalAudit(activeSession, {
					kind: "terminal.request",
					toolCallId: call.id,
					command: "",
					action: "requires_confirmation",
					reason: "missing-command",
					cwd: getCurrentCwd(),
				});
				appendTerminalAudit(activeSession, {
					kind: "terminal.execution_result",
					toolCallId: call.id,
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
					toolCallId: call.id,
					...buildRealtimeTerminalPlanAuditFields(plan),
					cwd: getCurrentCwd(),
				});
				if (plan.action !== "allow") {
					outputText = stageCommandProposal(activeSession, call, "terminal", command, plan.reason, { command }, plan);
					deferToolResponse = true;
				} else if (activeSession.nonBlockingEnabled) {
					deferToolResponse = true;
					executeRealtimeTerminalCommand(activeSession, plan, call.id)
						.then((result) => {
							sendRealtimeToolResponse(activeSession, call, result, {
								scheduling: FunctionResponseScheduling.WHEN_IDLE,
							});
						})
						.catch((err) => {
							sendRealtimeToolResponse(activeSession, call, JSON.stringify({ ok: false, error: err?.message || String(err) }), {
								scheduling: FunctionResponseScheduling.INTERRUPT,
							});
						});
				} else {
					outputText = await executeRealtimeTerminalCommand(activeSession, plan, call.id);
				}
			}
		} else if (call.name === "propose_command") {
			const commandType = call.args?.commandType as string;
			const command = call.args?.command as string;
			const description = call.args?.description as string;
			const args = (call.args?.args as Record<string, unknown>) ?? {};
			if (!commandType || !command || !description) {
				outputText = JSON.stringify({ ok: false, error: "Missing commandType, command, or description." });
			} else {
				let plan: RealtimeTerminalCommandPlan | undefined;
				if (commandType === "execute_terminal_command" && typeof args.command === "string") {
					plan = buildRealtimeTerminalCommandPlan(args.command);
				}
				if (commandType === "chat" && typeof args.agentId === "string" && typeof args.text === "string") {
					const proposal = await prepareAgentHubProposal(activeSession, "chat", args.agentId, args.text);
					if (!proposal.ok) {
						outputText = JSON.stringify({ ok: false, error: proposal.error });
					} else {
						outputText = stageCommandProposal(activeSession, call, "chat", command, description, { ...args, proposalToken: proposal.token });
						deferToolResponse = true;
					}
				} else if (commandType === "kill" && typeof args.agentId === "string") {
					const proposal = await prepareAgentHubProposal(activeSession, "kill", args.agentId);
					if (!proposal.ok) {
						outputText = JSON.stringify({ ok: false, error: proposal.error });
					} else {
						outputText = stageCommandProposal(activeSession, call, "kill", command, description, { ...args, proposalToken: proposal.token });
						deferToolResponse = true;
					}
				} else {
					outputText = stageCommandProposal(activeSession, call, commandType as any, command, description, args, plan);
					deferToolResponse = true;
				}
			}
		} else if (call.name === "list_agents") {
			if (server && typeof server.agentHubSnapshot === "function") {
				const snapshot = await server.agentHubSnapshot();
				outputText = JSON.stringify({
					ok: true,
					generatedAtMs: Date.now(),
					folders: snapshot.folders.map((f: any) => ({ key: f.key, name: f.name, laneCount: f.laneCount })),
					agents: snapshot.agents.map((a: any) => ({
						id: a.id,
						name: a.displayName,
						kind: a.kind,
						status: a.status,
						model: a.model,
						cwd: a.cwd,
						lastActivityMs: a.lastActivityMs,
						needsAttention: a.needsAttention,
					})),
				});
			} else {
				outputText = JSON.stringify({ ok: false, error: "Agent hub snapshot is not available." });
			}
		} else if (call.name === "get_agent") {
			const agentId = call.args?.agentId as string;
			const lines = Math.min(Math.max(0, Number(call.args?.lines) || 80), 500);
			if (!agentId) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'agentId' argument" });
			} else if (server && typeof server.agentHubDetail === "function") {
				const agent = await server.agentHubDetail(agentId, lines);
				outputText = JSON.stringify({ ok: !!agent, agent });
			} else {
				outputText = JSON.stringify({ ok: false, error: "Agent hub detail is not available." });
			}
		} else if (call.name === "read_transcript") {
			const agentId = call.args?.agentId as string;
			const lines = Math.min(Math.max(0, Number(call.args?.lines) || 80), 500);
			if (!agentId) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'agentId' argument" });
			} else if (server && typeof server.agentHubDetail === "function") {
				const agent = await server.agentHubDetail(agentId, lines);
				outputText = JSON.stringify({ ok: !!agent, agentId, transcriptTail: agent?.transcriptTail ?? [], transcriptSize: agent?.transcriptSize ?? 0 });
			} else {
				outputText = JSON.stringify({ ok: false, error: "Agent hub detail is not available." });
			}
		} else if (call.name === "list_workspace") {
			const path = call.args?.path as string | undefined;
			if (server && typeof server.getWorkspaceDirectory === "function") {
				outputText = JSON.stringify({ ok: true, workspace: server.getWorkspaceDirectory(path) });
			} else {
				outputText = JSON.stringify({ ok: false, error: "Workspace listing is not available." });
			}
		} else if (call.name === "read_workspace_file") {
			const path = call.args?.path as string;
			if (!path) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'path' argument" });
			} else if (server && typeof server.getWorkspaceFile === "function") {
				outputText = JSON.stringify(server.getWorkspaceFile(path));
			} else {
				outputText = JSON.stringify({ ok: false, error: "Workspace file read is not available." });
			}
		} else if (call.name === "switch_session") {
			const name = call.args?.name as string;
			if (!name) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'name' argument" });
			} else {
				const persisted = loadPersistedSessionRouting();
				let matchedPath: string | undefined;
				let matchedName: string | undefined;
				for (const [sName, sPath] of Object.entries(persisted.sessions)) {
					if (sName.toLowerCase() === name.toLowerCase()) {
						matchedPath = sPath;
						matchedName = sName;
						break;
					}
				}
				if (!matchedPath) {
					for (const [alias, sPath] of Object.entries(persisted.aliases)) {
						if (alias.toLowerCase() === name.toLowerCase()) {
							matchedPath = sPath;
							matchedName = findSessionNameByPath(sPath, persisted.sessions) || alias;
							break;
						}
					}
				}
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
					const snapshots = readAttentionSnapshots();
					const runningSession = snapshots.find(s => s.sessionPath === matchedPath);
					if (runningSession) {
						claimAttentionLeader(runningSession.sessionId);
						if (server && typeof server.setRoutingTarget === "function") {
							await server.setRoutingTarget(matchedName || matchedPath);
						}
						outputText = JSON.stringify({
							ok: true,
							message: `Switched routing target to active session: ${matchedName || matchedPath}`,
							sessionPath: matchedPath,
							sessionId: runningSession.sessionId,
							active: true,
						});
					} else {
						if (server && typeof server.onSessionResume === "function") {
							const resumeRes = await server.onSessionResume({ sessionPath: matchedPath });
							outputText = JSON.stringify({ ok: resumeRes.ok, message: resumeRes.message, sessionPath: matchedPath, active: false });
						} else {
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
									outputText = JSON.stringify({ ok: false, error: `Unable to resume session: unsupported provider ${session.provider}` });
								}
							} else {
								outputText = JSON.stringify({ ok: false, error: "Session found in routing store but not in recent resume inventory." });
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
			if (server && typeof server.getSessionDashboard === "function") {
				const dashboard = server.getSessionDashboard();
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
			const description = prompt ? `Launch agent: ${prompt}` : hubOnly ? "Open the agent hub" : targetNode === "colab" ? "Deploy workspace to Colab" : "Launch agent";
			outputText = stageCommandProposal(activeSession, call, "launch", prompt || "launch_agent", description, { prompt, cwd, hubOnly, targetNode });
			deferToolResponse = true;
		} else if (call.name === "archive_session") {
			const sessionPath = call.args?.sessionPath as string;
			const action = (call.args?.action as string) === "recover" ? "recover" : "archive";
			if (!sessionPath) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'sessionPath' argument" });
			} else {
				const description = `${action === "recover" ? "Recover" : "Archive"} session ${sessionPath}`;
				outputText = stageCommandProposal(activeSession, call, "archive", `${action}:${sessionPath}`, description, { sessionPath, action });
				deferToolResponse = true;
			}
		} else if (call.name === "chat_agent") {
			const agentId = call.args?.agentId as string;
			const text = call.args?.text as string;
			if (!agentId || !text) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'agentId' or 'text' argument" });
			} else {
				const proposal = await prepareAgentHubProposal(activeSession, "chat", agentId, text);
				if (!proposal.ok) {
					outputText = JSON.stringify({ ok: false, error: proposal.error });
				} else {
					outputText = stageCommandProposal(activeSession, call, "chat", `Chat to ${agentId}: ${text}`, `Send message to ${agentId}`, { agentId, text, proposalToken: proposal.token });
					deferToolResponse = true;
				}
			}
		} else if (call.name === "kill_agent") {
			const agentId = call.args?.agentId as string;
			if (!agentId) {
				outputText = JSON.stringify({ ok: false, error: "Missing 'agentId' argument" });
			} else {
				const proposal = await prepareAgentHubProposal(activeSession, "kill", agentId);
				if (!proposal.ok) {
					outputText = JSON.stringify({ ok: false, error: proposal.error });
				} else {
					outputText = stageCommandProposal(activeSession, call, "kill", `Kill agent ${agentId}`, `Archive (kill) agent ${agentId}`, { agentId, proposalToken: proposal.token });
					deferToolResponse = true;
				}
			}
		} else {
			outputText = JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
		}
	} catch (err: any) {
		outputText = JSON.stringify({ ok: false, error: err.message });
	}
	return { outputText, deferToolResponse };
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
					resolveCommandApproval(activeSession, ctrl.approvalId, ctrl.type === "terminal_approve").catch((err) => {
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
		activeSession.disconnectTimeout = setTimeout(() => {
			try {
				activeSession.session?.close();
			} catch {}
			activeSessions.delete(activeSession.sessionId);
		}, 60000); // 60 seconds timeout
	});
}

type ReconnectContext = {
	resumptionHandle?: string;
	pendingToolResponses: Record<string, unknown>[];
	priorSessionId: string;
};

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

	// Tool definitions
	const tools = [
		{
			functionDeclarations: [
				{
					name: "execute_terminal_command",
					description: "Executes a shell command in the local workspace. Read-only allowlisted commands run immediately. Mutating, risky, or unknown commands are staged as a proposal that requires user approval before running.",
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
					name: "propose_command",
					description: "Propose a mutating command to the user before executing it. Use for launch_agent, chat/kill subagent actions, archive_session, execute_terminal_command, or multi-step plans. Returns a confirmation token and a human-readable description; nothing runs until the user approves.",
					parameters: {
						type: "OBJECT",
						properties: {
							commandType: {
								type: "STRING",
								description: "The command being proposed: execute_terminal_command, launch_agent, chat, kill, archive_session, or multi_step."
							},
							command: {
								type: "STRING",
								description: "A concise, human-readable description of the command to run."
							},
							description: {
								type: "STRING",
								description: "A conversational explanation of why you want to run it and what it will do."
							},
							args: {
								type: "OBJECT",
								description: "The arguments for the proposed command, matching the target tool's parameters."
							}
						},
						required: ["commandType", "command", "description"]
					}
				},
				{
					name: "list_agents",
					description: "Lists all subagents and background lanes, grouped by workspace, with their status and recent activity. Read-only.",
					parameters: {
						type: "OBJECT",
						properties: {}
					}
				},
				{
					name: "get_agent",
					description: "Gets details about a single subagent or background lane, including its status, model, and cwd. Read-only.",
					parameters: {
						type: "OBJECT",
						properties: {
							agentId: { type: "STRING", description: "The agent id." },
							lines: { type: "INTEGER", description: "Number of transcript tail lines to include (default 80, max 500)." }
						},
						required: ["agentId"]
					}
				},
				{
					name: "read_transcript",
					description: "Reads the recent transcript tail of a subagent or background lane. Read-only.",
					parameters: {
						type: "OBJECT",
						properties: {
							agentId: { type: "STRING", description: "The agent id." },
							lines: { type: "INTEGER", description: "Number of transcript lines to return (default 80, max 500)." }
						},
						required: ["agentId"]
					}
				},
				{
					name: "list_workspace",
					description: "Lists the contents of a workspace directory. Read-only.",
					parameters: {
						type: "OBJECT",
						properties: {
							path: { type: "STRING", description: "Optional directory path. Defaults to the workspace root." }
						}
					}
				},
				{
					name: "read_workspace_file",
					description: "Reads the contents of a workspace file (text or binary notice). Read-only.",
					parameters: {
						type: "OBJECT",
						properties: {
							path: { type: "STRING", description: "The file path to read." }
						},
						required: ["path"]
					}
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
					description: "Launches a new oh-my-pk background agent, opens the agent hub, or starts the Colab deployment flow when targetNode is 'colab'. This is a mutating command; the assistant should propose it via propose_command and only call it directly after user approval.",
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
					description: "Archives or recovers a session by its path. Archived sessions are hidden from the dashboard but fully recoverable. This is a mutating command; the assistant should propose it via propose_command and only call it directly after user approval.",
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
					name: "chat_agent",
					description: "Sends a chat message to an oh-my-pk background lane or subagent. This is a mutating command; the assistant should propose it via propose_command and only call it directly after user approval.",
					parameters: {
						type: "OBJECT",
						properties: {
							agentId: { type: "STRING", description: "The agent id to chat with." },
							text: { type: "STRING", description: "The message to send." }
						},
						required: ["agentId", "text"]
					}
				},
				{
					name: "kill_agent",
					description: "Archives (kills) an oh-my-pk background lane or subagent. This is a mutating command; the assistant should propose it via propose_command and only call it directly after user approval.",
					parameters: {
						type: "OBJECT",
						properties: {
							agentId: { type: "STRING", description: "The agent id to archive." }
						},
						required: ["agentId"]
					}
				}
			]
		}
	];

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
							const toolCall = { id: call.id, name: call.name, args: call.args };

							// Send tool_start event
							sendToClient(activeSession, {
								type: "tool_start",
								name: call.name,
								command: call.args?.command as string || undefined,
							}, false);

							const dispatchResult = await dispatchRealtimeToolCall(activeSession, toolCall);
							const outputText = dispatchResult.outputText;
							if (dispatchResult.deferToolResponse) continue;

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
