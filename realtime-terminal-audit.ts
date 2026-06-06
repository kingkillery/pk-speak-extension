import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSessionRoutingStorePath } from "./session-routing-store.js";
import type { RealtimeTerminalCommandPlan } from "./realtime-terminal-command.js";

export type RealtimeTerminalAuditKind =
	| "terminal.request"
	| "terminal.approval_requested"
	| "terminal.approval_resolved"
	| "terminal.execution_result";

export type RealtimeTerminalAuditText = {
	text: string;
	length: number;
	truncated: boolean;
};

export type RealtimeTerminalAuditResult = {
	ok: boolean;
	code?: number | null;
	skipped?: "rejected" | "expired" | "not-executable" | "missing-command";
	stdout?: RealtimeTerminalAuditText;
	stderr?: RealtimeTerminalAuditText;
};

export type RealtimeTerminalAuditEvent = {
	ts: number;
	kind: RealtimeTerminalAuditKind;
	sessionId?: string;
	provider?: string;
	model?: string;
	toolCallId?: string;
	approvalId?: string;
	command?: string;
	normalizedCommand?: string;
	commandFamily?: string;
	action?: string;
	reason?: string;
	cwd?: string;
	timeoutMs?: number;
	executableKnown?: boolean;
	secretInspection?: boolean;
	approved?: boolean;
	decision?: string;
	result?: RealtimeTerminalAuditResult;
};

const DEFAULT_AUDIT_TEXT_LIMIT = 4_000;

export function getRealtimeTerminalAuditPath() {
	return join(dirname(getSessionRoutingStorePath()), "realtime-terminal-audit.jsonl");
}

function auditTextLimit() {
	const parsed = Number.parseInt(process.env.PI_SPEAK_REALTIME_TERMINAL_AUDIT_TEXT_CHARS || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUDIT_TEXT_LIMIT;
}

function redactSensitiveText(text: string) {
	return text
		.replace(
			/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)(["']?)[^\s"',}]+/gi,
			"$1$2[redacted]",
		)
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
}

export function buildRealtimeTerminalAuditText(value: string | undefined, limit = auditTextLimit()): RealtimeTerminalAuditText {
	const raw = value || "";
	const redacted = redactSensitiveText(raw);
	const truncated = redacted.length > limit;
	return {
		text: truncated ? redacted.slice(0, limit) : redacted,
		length: raw.length,
		truncated,
	};
}

export function buildRealtimeTerminalAuditResult(result: {
	ok: boolean;
	code?: number | null;
	stdout?: string;
	stderr?: string;
	skipped?: RealtimeTerminalAuditResult["skipped"];
}): RealtimeTerminalAuditResult {
	return {
		ok: result.ok,
		code: result.code,
		skipped: result.skipped,
		stdout: buildRealtimeTerminalAuditText(result.stdout),
		stderr: buildRealtimeTerminalAuditText(result.stderr),
	};
}

export function buildRealtimeTerminalPlanAuditFields(plan: RealtimeTerminalCommandPlan) {
	return {
		command: plan.command,
		normalizedCommand: plan.normalized,
		commandFamily: plan.family || "unregistered",
		action: plan.action,
		reason: plan.reason,
		timeoutMs: plan.timeoutMs,
		executableKnown: plan.executableKnown,
		secretInspection: plan.secretInspection,
	};
}

export function appendRealtimeTerminalAuditEvent(
	event: Omit<RealtimeTerminalAuditEvent, "ts"> & { ts?: number },
): RealtimeTerminalAuditEvent {
	const path = getRealtimeTerminalAuditPath();
	mkdirSync(dirname(path), { recursive: true });
	const entry: RealtimeTerminalAuditEvent = {
		ts: typeof event.ts === "number" ? event.ts : Date.now(),
		...event,
	};
	appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}

export function readRealtimeTerminalAuditEvents(): RealtimeTerminalAuditEvent[] {
	const path = getRealtimeTerminalAuditPath();
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as RealtimeTerminalAuditEvent);
}
