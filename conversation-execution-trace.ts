import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSessionRoutingStorePath } from "./session-routing-store.js";
import type { ConversationExecutionPlan } from "./conversation-execution-router.js";
import type { ConversationReducerSummary, RemoteTurnSource, TurnTimingSummary } from "./remote-turn-manager.js";

export type ExecutionTraceOutcome =
	| "no-input"
	| "skipped"
	| "dispatch-blocked"
	| "dispatch-failed"
	| "dispatch-success";

export type ExecutionDecision = {
	stage: "routing" | "dispatch" | "reply";
	outcome: "deferred" | "accepted" | "blocked" | "failed" | "succeeded";
	reason: string;
};

export type ExecutionPlanReplay = {
	dispatch: boolean;
	backend: ConversationExecutionPlan["backend"];
	reason: ConversationExecutionPlan["reason"];
	confidence: number;
	rationale: string;
	actionForSeed?: string;
	signals?: string[];
	goal?: string;
	actionItems?: string[];
	constraints?: string[];
	deferredReminders?: string[];
	doNotDo?: string[];
	unknowns?: string[];
	decisions?: ExecutionDecision[];
};

export type ActionPlanReplayRecord = {
	ts: number;
	source: RemoteTurnSource;
	outcome: ExecutionTraceOutcome;
	rawText: string;
	targetName?: string;
	transcript?: string;
	reducerSummary?: ConversationReducerSummary;
	executionPlan?: ConversationExecutionPlan;
	actionPlan?: ExecutionPlanReplay;
	providers?: {
		stt?: string;
		tts?: string;
		agent?: string;
	};
	timings?: TurnTimingSummary;
	warnings?: string[];
	error?: string;
};

export type ActionPlanReplayQuery = {
	limit?: number;
	source?: RemoteTurnSource;
	outcome?: ExecutionTraceOutcome;
	backend?: ConversationExecutionPlan["backend"];
	dispatch?: "all" | "dispatch" | "nondispatch";
};

export type ActionPlanReplayReadResult = {
	enabled: boolean;
	path: string;
	plans: ActionPlanReplayRecord[];
};

export type ExecutionTraceRecord = {
	ts: number;
	source: RemoteTurnSource;
	rawText: string;
	targetName?: string;
	transcript?: string;
	reducerSummary?: ConversationReducerSummary;
	executionPlan?: ConversationExecutionPlan;
	actionPlan?: ExecutionPlanReplay;
	outcome: ExecutionTraceOutcome;
	timings?: TurnTimingSummary;
	replyText?: string;
	warnings?: string[];
	error?: string;
	providers?: {
		stt?: string;
		tts?: string;
		agent?: string;
	};
};

export type ExecutionTraceQuery = {
	limit?: number;
	source?: RemoteTurnSource;
	outcome?: ExecutionTraceOutcome;
	backend?: ConversationExecutionPlan["backend"];
	dispatch?: "all" | "dispatch" | "nondispatch";
};

export type ExecutionTraceReadResult = {
	enabled: boolean;
	path: string;
	traces: ExecutionTraceRecord[];
};

const MAX_TRACE_LINES = 500;
const MAX_PLAN_LINES = 500;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;

function getExecutionTraceEnabled() {
	const raw = process.env.PI_SPEAK_EXECUTION_TRACES?.trim().toLowerCase();
	if (!raw) return true;
	const disabled = ["0", "false", "off", "disabled", "no"].includes(raw);
	return !disabled;
}

function getExecutionTracePath() {
	const overridePath = process.env.PI_SPEAK_EXECUTION_TRACE_PATH?.trim();
	if (overridePath) return overridePath;
	return join(dirname(getSessionRoutingStorePath()), "conversation-execution-traces.jsonl");
}

function getExecutionPlanPath() {
	const overridePath = process.env.PI_SPEAK_ACTION_PLAN_PATH?.trim();
	if (overridePath) return overridePath;
	return join(dirname(getSessionRoutingStorePath()), "conversation-action-plans.jsonl");
}

function readTraceLines(path: string) {
	if (!existsSync(path)) return [];
	const contents = readFileSync(path, "utf8");
	return contents.length > 0 ? contents.split(/\r?\n/).filter((line) => line.length > 0) : [];
}

function pruneTraceLines(lines: string[], maxLines: number) {
	return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
}

function sanitizeText(value: string, max = 3200) {
	if (!value) return "";
	return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function sanitizeTextList(values: string[] | undefined, maxItems = 8, maxLen = 140) {
	if (!Array.isArray(values) || values.length === 0) return [];
	return values
		.filter((value) => typeof value === "string")
		.map((value) => sanitizeText(value, maxLen))
		.slice(0, maxItems);
}

function sanitizeActionPlan(plan: ExecutionPlanReplay | undefined): ExecutionPlanReplay | undefined {
	if (!plan) return undefined;
	return {
		...plan,
		actionForSeed: plan.actionForSeed ? sanitizeText(plan.actionForSeed, 260) : undefined,
		rationale: sanitizeText(plan.rationale, 320),
		goal: plan.goal ? sanitizeText(plan.goal, 280) : undefined,
		actionItems: sanitizeTextList(plan.actionItems),
		constraints: sanitizeTextList(plan.constraints),
		deferredReminders: sanitizeTextList(plan.deferredReminders),
		doNotDo: sanitizeTextList(plan.doNotDo),
		unknowns: sanitizeTextList(plan.unknowns),
		decisions: Array.isArray(plan.decisions)
			? plan.decisions.map((entry) => ({
				...entry,
				reason: sanitizeText(entry.reason, 260),
			}))
			: [],
		signals: sanitizeTextList(plan.signals, 6, 80),
	};
}

function parseTraceLine(line: string) {
	try {
		return JSON.parse(line) as ExecutionTraceRecord;
	} catch {
		return undefined;
	}
}

function parsePlanLine(line: string) {
	try {
		return JSON.parse(line) as ActionPlanReplayRecord;
	} catch {
		return undefined;
	}
}

function pickRecent<T>(items: T[], limit: number) {
	if (!Array.isArray(items) || items.length === 0) return [];
	return items.length > limit ? items.slice(items.length - limit) : items;
}

function getQueryLimit(raw?: string) {
	const parsed = Number.parseInt(raw || "", 10);
	if (!Number.isFinite(parsed)) return DEFAULT_QUERY_LIMIT;
	if (parsed <= 0) return 1;
	if (parsed > MAX_QUERY_LIMIT) return MAX_QUERY_LIMIT;
	return parsed;
}

function appendTraceLine(path: string, line: string) {
	mkdirSync(dirname(path), { recursive: true });
	const lines = pruneTraceLines(readTraceLines(path), MAX_TRACE_LINES);
	lines.push(line);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function appendPlanLine(path: string, line: string) {
	mkdirSync(dirname(path), { recursive: true });
	const lines = pruneTraceLines(readTraceLines(path), MAX_PLAN_LINES);
	lines.push(line);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function sanitizeActionPlanRecord(entry: ActionPlanReplayRecord): ActionPlanReplayRecord {
	return {
		...entry,
		rawText: sanitizeText(entry.rawText),
		reducerSummary: entry.reducerSummary
			? {
					...entry.reducerSummary,
					goal: sanitizeText(entry.reducerSummary.goal, 280),
					actionItems: sanitizeTextList(entry.reducerSummary.actionItems),
					constraints: sanitizeTextList(entry.reducerSummary.constraints),
					deferredReminders: sanitizeTextList(entry.reducerSummary.deferredReminders),
					doNotDo: sanitizeTextList(entry.reducerSummary.doNotDo),
					unknowns: sanitizeTextList(entry.reducerSummary.unknowns),
					discarded: sanitizeTextList(entry.reducerSummary.discarded),
				}
			: undefined,
		executionPlan: entry.executionPlan
			? {
					dispatch: entry.executionPlan.dispatch,
					backend: entry.executionPlan.backend,
					reason: entry.executionPlan.reason,
					confidence: entry.executionPlan.confidence,
					rationale: sanitizeText(entry.executionPlan.rationale, 320),
					actionForSeed: typeof entry.executionPlan.actionForSeed === "string"
						? sanitizeText(entry.executionPlan.actionForSeed, 260)
						: undefined,
					signals: sanitizeTextList(entry.executionPlan.signals, 6, 80),
				}
			: undefined,
		actionPlan: sanitizeActionPlan(entry.actionPlan),
		timings: entry.timings ? { ...entry.timings } : undefined,
		warnings: sanitizeTextList(entry.warnings, 20, 220),
		error: entry.error ? sanitizeText(entry.error, 800) : undefined,
	};
}

function toActionPlanRecord(record: ExecutionTraceRecord): ActionPlanReplayRecord | undefined {
	if (!record.actionPlan) return undefined;
	return {
		ts: record.ts,
		source: record.source,
		outcome: record.outcome,
		rawText: record.rawText,
		targetName: record.targetName,
		transcript: record.transcript,
		reducerSummary: record.reducerSummary,
		executionPlan: record.executionPlan,
		actionPlan: record.actionPlan,
		providers: record.providers,
		timings: record.timings,
		warnings: record.warnings,
		error: record.error,
	};
}

export function appendExecutionTrace(record: ExecutionTraceRecord) {
	if (!getExecutionTraceEnabled()) return;
	try {
		const path = getExecutionTracePath();
		const payload = {
			...record,
			rawText: sanitizeText(record.rawText),
			replyText: record.replyText ? sanitizeText(record.replyText) : undefined,
		};
		const line = JSON.stringify(payload);
		appendTraceLine(path, line);
		const actionPlanRecord = toActionPlanRecord(payload);
		if (actionPlanRecord) {
			const planPath = getExecutionPlanPath();
			appendPlanLine(planPath, JSON.stringify(sanitizeActionPlanRecord(actionPlanRecord)));
		}
	} catch {
		// Trace persistence is best-effort and must never block user-visible turn flows.
	}
}

export function readExecutionPlans(query: ActionPlanReplayQuery = {}): ActionPlanReplayReadResult {
	const path = getExecutionPlanPath();
	if (!getExecutionTraceEnabled()) {
		return {
			enabled: false,
			path,
			plans: [],
		};
	}

	const limit = getQueryLimit(typeof query.limit === "number" ? String(query.limit) : undefined);
	const raw = readTraceLines(path);
	if (!raw.length) {
		return {
			enabled: true,
			path,
			plans: [],
		};
	}

	const parsed = raw
		.map((line) => parsePlanLine(line))
		.filter((value): value is ActionPlanReplayRecord =>
			!!value &&
			typeof value === "object" &&
			typeof value.ts === "number" &&
			typeof value.source === "string" &&
			typeof value.rawText === "string",
		)
		.filter((entry) => {
			if (query.source && entry.source !== query.source) return false;
			if (query.outcome && entry.outcome !== query.outcome) return false;
			if (query.backend && entry.executionPlan?.backend !== query.backend) return false;
			if (query.dispatch === "dispatch" && !entry.executionPlan?.dispatch) return false;
			if (query.dispatch === "nondispatch" && entry.executionPlan?.dispatch) return false;
			return true;
		})
		.map((entry) => ({
			...entry,
			rawText: sanitizeText(entry.rawText),
			reducerSummary: entry.reducerSummary
				? {
						...entry.reducerSummary,
						goal: sanitizeText(entry.reducerSummary.goal, 280),
						actionItems: sanitizeTextList(entry.reducerSummary.actionItems),
						constraints: sanitizeTextList(entry.reducerSummary.constraints),
						deferredReminders: sanitizeTextList(entry.reducerSummary.deferredReminders),
						doNotDo: sanitizeTextList(entry.reducerSummary.doNotDo),
						unknowns: sanitizeTextList(entry.reducerSummary.unknowns),
						discarded: sanitizeTextList(entry.reducerSummary.discarded),
					}
				: undefined,
			actionPlan: sanitizeActionPlan(entry.actionPlan),
			executionPlan: entry.executionPlan
				? {
						dispatch: entry.executionPlan.dispatch,
						backend: entry.executionPlan.backend,
						reason: entry.executionPlan.reason,
						confidence: entry.executionPlan.confidence,
						rationale: sanitizeText(entry.executionPlan.rationale, 320),
						actionForSeed: typeof entry.executionPlan.actionForSeed === "string"
							? sanitizeText(entry.executionPlan.actionForSeed, 260)
							: undefined,
						signals: sanitizeTextList(entry.executionPlan.signals, 6, 80),
					}
				: undefined,
			timings: entry.timings ? { ...entry.timings } : undefined,
			warnings: sanitizeTextList(entry.warnings, 20, 220),
			error: entry.error ? sanitizeText(entry.error, 800) : undefined,
		}));

	return {
		enabled: true,
		path,
		plans: pickRecent(parsed, limit).reverse(),
	};
}

export function readExecutionTraces(query: ExecutionTraceQuery = {}): ExecutionTraceReadResult {
	const path = getExecutionTracePath();
	if (!getExecutionTraceEnabled()) {
		return {
			enabled: false,
			path,
			traces: [],
		};
	}

	const limit = getQueryLimit(typeof query.limit === "number" ? String(query.limit) : undefined);
	const raw = readTraceLines(path);
	if (!raw.length) {
		return {
			enabled: true,
			path,
			traces: [],
		};
	}

	const parsed = raw
		.map((line) => parseTraceLine(line))
		.filter((value): value is ExecutionTraceRecord =>
			!!value &&
			typeof value === "object" &&
			typeof value.ts === "number" &&
			typeof value.source === "string" &&
			typeof value.rawText === "string",
		)
		.filter((entry) => {
			if (query.source && entry.source !== query.source) return false;
			if (query.outcome && entry.outcome !== query.outcome) return false;
			if (query.backend && entry.executionPlan?.backend !== query.backend) return false;
			if (query.dispatch === "dispatch" && !entry.executionPlan?.dispatch) return false;
			if (query.dispatch === "nondispatch" && entry.executionPlan?.dispatch) return false;
			return true;
		})
		.map((entry) => ({
			...entry,
			rawText: sanitizeText(entry.rawText),
			replyText: entry.replyText ? sanitizeText(entry.replyText) : undefined,
			timings: entry.timings ? { ...entry.timings } : undefined,
			actionPlan: sanitizeActionPlan(entry.actionPlan),
			reducerSummary: entry.reducerSummary
				? {
						...entry.reducerSummary,
						goal: sanitizeText(entry.reducerSummary.goal, 280),
						actionItems: sanitizeTextList(entry.reducerSummary.actionItems),
							constraints: sanitizeTextList(entry.reducerSummary.constraints),
							deferredReminders: sanitizeTextList(entry.reducerSummary.deferredReminders),
							doNotDo: sanitizeTextList(entry.reducerSummary.doNotDo),
							unknowns: sanitizeTextList(entry.reducerSummary.unknowns),
							discarded: sanitizeTextList(entry.reducerSummary.discarded),
						}
					: undefined,
		})); 

	return {
		enabled: true,
		path,
		traces: pickRecent(parsed, limit).reverse(),
	};
}
