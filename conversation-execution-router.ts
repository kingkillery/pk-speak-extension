import type { ConversationReducerSummary } from "./remote-turn-manager.js";

export type ExecutionBackend = "pi" | "codex" | "claude" | "oh-my-pi" | "shell" | "memory" | "wiki" | "defer";

export type ExecutionRouteReason =
	| "dispatch-pi"
	| "dispatch-codex"
	| "dispatch-claude"
	| "dispatch-oh-my-pi"
	| "dispatch-shell"
	| "dispatch-memory"
	| "dispatch-wiki"
	| "defer"
	| "clarify";

type RouteSignal = {
	backend: ExecutionBackend;
	reason: ExecutionRouteReason;
	rationale: string;
	confidence: number;
	signals?: string[];
};

export type ConversationExecutionPlan = {
	dispatch: boolean;
	backend: ExecutionBackend;
	reason: ExecutionRouteReason;
	confidence: number;
	rationale: string;
	actionForSeed?: string;
	signals?: string[];
	routeClass?: "fast" | "fast-plus-tools" | "slow-think";
	riskLevel?: "low" | "medium" | "high";
	latencyBudgetMs?: number;
	costTier?: "T0" | "T1" | "T2" | "T3";
	userAck?: string;
	userProgress?: string;
	escalationReason?: string;
};

type RouteClass = NonNullable<ConversationExecutionPlan["routeClass"]>;
type RouteRiskLevel = NonNullable<ConversationExecutionPlan["riskLevel"]>;
type RouteCostTier = NonNullable<ConversationExecutionPlan["costTier"]>;

type ExecutionRouterMode = "auto" | "pi" | "codex" | "claude" | "oh-my-pi";

const SHELL_KEYWORDS = [
	"bash",
	"cmd",
	"powershell",
	"pwsh",
	"node",
	"python",
	"npm",
	"pnpm",
	"yarn",
	"docker",
	"kubectl",
	"git",
	"curl",
	"wget",
	"find",
	"grep",
	"rg",
	"sed",
	"awk",
	"tail",
	"head",
	"cat",
	"ls",
	"dir",
	"copy",
	"move",
	"rename",
	"rm",
	"del",
	"mkdir",
	"rmdir",
	"kill",
	"service",
	"systemctl",
	"ssh",
	"scp",
	"rsync",
	"make",
	"pytest",
	"gradle",
	"mvn",
	"cargo",
];

const MEMORY_KEYWORDS = [
	"remember",
	"note",
	"log",
	"note this",
	"note down",
	"capture",
	"trace",
	"decision",
	"decide",
	"record",
	"save",
];

const WIKI_KEYWORDS = [
	"wiki",
	"document",
	"documentation",
	"docs",
	"markdown",
	"md",
	"decision log",
	"summary",
	"summarize",
	"summarise",
	"research note",
	"knowledge note",
];

const DEFER_KEYWORDS = [
	"later",
	"hold",
	"defer",
	"remember later",
	"when possible",
	"someday",
	"follow up",
	"follow-up",
	"for later",
	"later on",
];

const EXPLICIT_DEFER_SIGNALS = [
	"defer",
	"park this",
	"park that",
	"park it",
	"hold this",
	"hold on",
	"hold it",
	"hold for now",
	"shelve",
	"put on hold",
	"put this on hold",
	"put that on hold",
	"defer this",
	"defer that",
	"defer this task",
	"defer that task",
	"defer it",
	"follow up",
	"follow-up",
	"for later",
	"maybe later",
	"later today",
	"later this week",
	"at some point",
	"at a later time",
	"when you're free",
	"when possible",
	"if time allows",
	"remind me later",
];

const EXPLICIT_SHELL_SIGNALS = [
	"run shell",
	"run command",
	"run command:",
	"run this command",
	"run that command",
	"run this",
	"run that",
	"run \"",
	"execute command",
	"execute this command",
	"execute this",
	"execute that",
	"execute script",
	"run script",
	"start command",
	"stop command",
	"restart service",
	"restart this",
	"start service",
	"stop service",
	"kill process",
	"kill process ",
	"kill this process",
	"show logs",
	"show log",
	"show log output",
	"tail logs",
	"tail this file",
	"tail this",
	"print logs",
	"grep",
	"grep for",
	"find ",
	"find files",
	"ls ",
	"pwd",
	"list files",
	"list directory",
	"list of files",
	"copy file",
	"move file",
	"delete file",
	"remove file",
	"make directory",
	"list process",
	"rm ",
	"mkdir",
	"rmdir",
	"bash",
	"powershell",
	"python ",
	"node ",
	"npm ",
	"pnpm ",
	"yarn ",
	"docker",
	"kubectl",
	"git",
	"curl",
	"wget",
	"scp ",
	"ssh ",
	"scp",
	"rsync",
];

const EXPLICIT_MEMORY_SIGNALS = [
	"remember this",
	"remember that",
	"remember now",
	"remember",
	"remember that for later",
	"note this",
	"note down",
	"note about",
	"note to self",
	"note this for later",
	"note these",
	"capture this",
	"capture that",
	"log this",
	"log this as",
	"log these notes",
	"log summary",
	"save this",
	"save that",
	"save it",
	"save for later",
	"save this for later",
	"record this",
	"record that",
	"take note",
	"take notes",
	"document this memory",
	"capture it",
	"record a note",
	"log a note",
	"decision log",
];

const EXPLICIT_WIKI_SIGNALS = [
	"document",
	"documentation",
	"document this",
	"document that",
	"docs ",
	"wiki",
	"add docs",
	"update docs",
	"write docs",
	"write documentation",
	"add to docs",
	"summarize",
	"summarise",
	"document this feature",
	"document this change",
	"documentation for",
	"write a summary",
	"create a summary",
	"research note",
	"knowledge note",
];

const CANDIDATE_CODEX_KEYWORDS = [
	"create",
	"add",
	"remove",
	"delete",
	"edit",
	"write",
	"update",
	"rename",
	"move",
	"fix",
	"build",
	"deploy",
	"refactor",
	"implement",
	"ship",
	"pair",
	"test",
];

const CANDIDATE_PI_KEYWORDS = [
	"check",
	"inspect",
	"find",
	"search",
	"show",
	"explain",
	"analyze",
	"analyzer",
	"status",
	"compare",
	"review",
	"open",
	"route",
];

const SLOW_THINK_KEYWORDS = [
	"architecture",
	"architectural",
	"comprehensive",
	"deep",
	"difficult",
	"expert",
	"in depth",
	"investigate",
	"multi step",
	"pristine",
	"production",
	"refactor",
	"review",
	"root cause",
	"security",
	"ship",
	"thorough",
	"wire",
];

const HIGH_RISK_KEYWORDS = [
	"delete",
	"remove",
	"rm",
	"del",
	"destructive",
	"credentials",
	"secret",
	"token",
	"auth",
	"production",
	"deploy",
	"publish",
	"payment",
	"legal",
	"financial",
];

function normalizeText(value: string) {
	return value
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function splitWords(value: string) {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_]+/gu, " ")
		.split(" ")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function escapeForRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasKeywordInText(text: string, keyword: string) {
	const normalizedText = normalizeText(text);
	const normalizedKeyword = normalizeText(keyword);
	if (!normalizedKeyword) return false;
	if (normalizedKeyword.includes(" ")) {
		return normalizedText === normalizedKeyword
			|| normalizedText.startsWith(`${normalizedKeyword} `)
			|| normalizedText.endsWith(` ${normalizedKeyword}`)
			|| normalizedText.includes(` ${normalizedKeyword} `);
	}
	const regex = new RegExp(`\\b${escapeForRegex(normalizedKeyword)}\\b`, "u");
	return regex.test(normalizedText);
}

function findKeywordSignals(text: string, keywords: string[]) {
	const hits: string[] = [];
	for (const keyword of keywords) {
		if (hasKeywordInText(text, keyword)) hits.push(keyword);
	}
	return hits;
}

function readExecutionMode() {
	const configuredMode = process.env.PI_SPEAK_EXECUTION_ROUTER_MODE;
	const mode = (configuredMode || "").trim().toLowerCase();
	if (mode === "pi" || mode === "codex" || mode === "claude" || mode === "oh-my-pi" || mode === "auto") return mode as ExecutionRouterMode;
	const provider = (process.env.AGENT_PROVIDER || "").trim().toLowerCase();
	if (provider === "pi" || provider === "codex" || provider === "claude" || provider === "oh-my-pi") return provider as Exclude<ExecutionRouterMode, "auto">;
	return "auto";
}

function hasKeywordInValues(values: string[], keywords: string[]) {
	return values.some((value) => keywords.some((keyword) => value.includes(keyword)));
}

function detectSignalRoute(summary: ConversationReducerSummary): RouteSignal | undefined {
	const allSignalText = [
		summary.goal,
		...summary.actionItems,
		...summary.constraints,
		...summary.deferredReminders,
	].join(" ");
	const normalized = normalizeText(allSignalText);
	if (!normalized) return undefined;

	const explicitDefer = findKeywordSignals(normalized, EXPLICIT_DEFER_SIGNALS);
	if (explicitDefer.length > 0) {
		return {
			backend: "defer",
			reason: "defer",
			confidence: 0.94,
			rationale: `I detected explicit defer intent (${explicitDefer.slice(0, 2).join(", ")}).`,
			signals: explicitDefer,
		};
	}

	const explicitShell = findKeywordSignals(normalized, EXPLICIT_SHELL_SIGNALS);
	if (explicitShell.length > 0) {
		return {
			backend: "shell",
			reason: "dispatch-shell",
			confidence: Math.max(0.85, summary.confidence),
			rationale: `I detected explicit shell intent (${explicitShell.slice(0, 2).join(", ")}).`,
			signals: explicitShell,
		};
	}

	const explicitMemory = findKeywordSignals(normalized, EXPLICIT_MEMORY_SIGNALS);
	if (explicitMemory.length > 0) {
		return {
			backend: "memory",
			reason: "dispatch-memory",
			confidence: Math.max(0.88, summary.confidence),
			rationale: `I detected explicit memory intent (${explicitMemory.slice(0, 2).join(", ")}).`,
			signals: explicitMemory,
		};
	}

	const explicitWiki = findKeywordSignals(normalized, EXPLICIT_WIKI_SIGNALS);
	if (explicitWiki.length > 0) {
		return {
			backend: "wiki",
			reason: "dispatch-wiki",
			confidence: Math.max(0.88, summary.confidence),
			rationale: `I detected explicit wiki intent (${explicitWiki.slice(0, 2).join(", ")}).`,
			signals: explicitWiki,
		};
	}

	const defer = findKeywordSignals(normalized, DEFER_KEYWORDS);
	if (defer.length > 0) {
		return {
			backend: "defer",
			reason: "defer",
			// Weak defer signal (plain "later"/"hold" keywords, not an explicit defer
			// phrase): keep it deliberately low but reflect the reducer's actual
			// confidence rather than a hard-coded constant. The previous
			// `Math.max(0.1, 0.05)` was always 0.1 — a typo that discarded
			// summary.confidence (every sibling weak route uses it), surfacing
			// meaningless telemetry on this branch.
			confidence: Math.max(0.1, summary.confidence),
			rationale: `I detected follow-up/defer intent (${defer.slice(0, 2).join(", ")}).`,
		};
	}

	const shell = findKeywordSignals(normalized, SHELL_KEYWORDS);
	if (shell.length > 0) {
		return {
			backend: "shell",
			reason: "dispatch-shell",
			confidence: summary.confidence,
			rationale: `I mapped this turn to shell execution for: ${shell.slice(0, 2).join(", ")}.`,
		};
	}

	const wiki = findKeywordSignals(normalized, WIKI_KEYWORDS);
	if (wiki.length > 0) {
		return {
			backend: "wiki",
			reason: "dispatch-wiki",
			confidence: summary.confidence,
			rationale: `I mapped this turn to wiki notes for: ${wiki.slice(0, 2).join(", ")}.`,
		};
	}

	const memory = findKeywordSignals(normalized, MEMORY_KEYWORDS);
	if (memory.length > 0) {
		return {
			backend: "memory",
			reason: "dispatch-memory",
			confidence: summary.confidence,
			rationale: `I mapped this turn to memory capture for: ${memory.slice(0, 2).join(", ")}.`,
		};
	}

	return undefined;
}

function routeByKeywords(summary: ConversationReducerSummary): ExecutionBackend {
	const actionText = summary.actionItems.join(" ").toLowerCase();
	const words = splitWords(actionText);
	if (hasKeywordInValues(words, CANDIDATE_CODEX_KEYWORDS)) return "codex";
	if (hasKeywordInValues(words, CANDIDATE_PI_KEYWORDS)) return "pi";
	return "pi";
}

function classifyRoute(plan: Omit<ConversationExecutionPlan, "routeClass" | "riskLevel" | "latencyBudgetMs" | "costTier" | "userAck" | "userProgress" | "escalationReason">, summary: ConversationReducerSummary) {
	const allText = normalizeText([
		summary.goal,
		...summary.actionItems,
		...summary.constraints,
		...summary.doNotDo,
		plan.rationale,
	].join(" "));
	const slowSignals = findKeywordSignals(allText, SLOW_THINK_KEYWORDS);
	const riskSignals = findKeywordSignals(allText, HIGH_RISK_KEYWORDS);
	const multiAction = summary.actionItems.length >= 2;
	const lowConfidence = summary.confidence < 0.62;
	const routeClass: RouteClass = !plan.dispatch
		? "fast"
		: plan.backend === "codex" || plan.backend === "claude" || slowSignals.length > 0 || multiAction || lowConfidence || riskSignals.length > 0
			? "slow-think"
			: plan.backend === "pi"
				? "fast-plus-tools"
				: "fast-plus-tools";
	const riskLevel: RouteRiskLevel = riskSignals.length > 0
		? "high"
		: routeClass === "slow-think" || multiAction || lowConfidence
			? "medium"
			: "low";
	const latencyBudgetMs = routeClass === "fast" ? 50 : routeClass === "fast-plus-tools" ? 200 : 1000;
	const costTier: RouteCostTier = routeClass === "fast" ? "T0" : routeClass === "fast-plus-tools" ? "T1" : riskLevel === "high" ? "T3" : "T2";
	const escalationReason = routeClass === "slow-think"
		? [
				plan.backend === "codex" || plan.backend === "claude" ? "file-changing coding workflow" : "",
				multiAction ? "multiple action items" : "",
				lowConfidence ? "medium confidence route" : "",
				slowSignals.length ? `complexity signal: ${slowSignals[0]}` : "",
				riskSignals.length ? `risk signal: ${riskSignals[0]}` : "",
			].filter(Boolean).join("; ")
		: undefined;
	const userAck = routeClass === "slow-think"
		? "I'll need to think for a minute on this one. I'm starting the full coding workflow now."
		: undefined;
	const userProgress = routeClass === "slow-think"
		? userAck
		: routeClass === "fast-plus-tools"
			? "I'm checking that now."
			: undefined;
	return {
		routeClass,
		riskLevel,
		latencyBudgetMs,
		costTier,
		userAck,
		userProgress,
		escalationReason,
	};
}

function withRouteMetadata(plan: Omit<ConversationExecutionPlan, "routeClass" | "riskLevel" | "latencyBudgetMs" | "costTier" | "userAck" | "userProgress" | "escalationReason">, summary: ConversationReducerSummary): ConversationExecutionPlan {
	return {
		...plan,
		...classifyRoute(plan, summary),
	};
}

export function planConversationExecution(
	summary: ConversationReducerSummary,
	options: {
		mode?: ExecutionRouterMode;
		targetName?: string;
		provider?: "pi" | "codex" | "claude" | "oh-my-pi";
	} = {},
): ConversationExecutionPlan {
	const mode = options.mode || readExecutionMode();
	const signalRoute = detectSignalRoute(summary);
	if (signalRoute) {
		return withRouteMetadata({
			dispatch: false,
			backend: signalRoute.backend,
			reason: signalRoute.reason,
			confidence: signalRoute.confidence,
			rationale: signalRoute.rationale,
			signals: signalRoute.signals,
			actionForSeed: summary.actionItems[0] || summary.goal,
		}, summary);
	}

	if (!summary.shouldDispatch || summary.actionItems.length === 0) {
		return withRouteMetadata({
			dispatch: false,
			backend: "pi",
			reason: "clarify",
			confidence: summary.confidence,
			rationale: summary.clarifyingQuestion
				? summary.clarifyingQuestion
				: "I need a concrete action to dispatch.",
		}, summary);
	}

	const targetContext = options.targetName ? ` target ${options.targetName}` : "";
	if (options.provider) {
		return withRouteMetadata({
			dispatch: true,
			backend: options.provider,
			reason: options.provider === "codex"
				? "dispatch-codex"
				: options.provider === "claude"
					? "dispatch-claude"
					: options.provider === "oh-my-pi"
						? "dispatch-oh-my-pi"
						: "dispatch-pi",
			confidence: summary.confidence,
			rationale: `Routing to ${describeBackend(options.provider)} because the client selected that backend.${targetContext}`,
			actionForSeed: summary.actionItems[0] || "execute task",
		}, summary);
	}
	if (mode === "pi") {
		return withRouteMetadata({
			dispatch: true,
			backend: "pi",
			reason: "dispatch-pi",
			confidence: summary.confidence,
			rationale: `Routing to Pi for ${summary.actionItems.length} action item(s)${targetContext}.`,
			actionForSeed: summary.actionItems[0] || "execute task",
		}, summary);
	}
	if (mode === "oh-my-pi") {
		return withRouteMetadata({
			dispatch: true,
			backend: "oh-my-pi",
			reason: "dispatch-oh-my-pi",
			confidence: summary.confidence,
			rationale: `Routing to Oh-my-pi for ${summary.actionItems.length} action item(s)${targetContext}.`,
			actionForSeed: summary.actionItems[0] || "execute task",
		}, summary);
	}
	if (mode === "codex") {
		return withRouteMetadata({
			dispatch: true,
			backend: "codex",
			reason: "dispatch-codex",
			confidence: summary.confidence,
			rationale: `Routing to Codex for ${summary.actionItems.length} action item(s)${targetContext}.`,
			actionForSeed: summary.actionItems[0] || "execute task",
		}, summary);
	}
	if (mode === "claude") {
		return withRouteMetadata({
			dispatch: true,
			backend: "claude",
			reason: "dispatch-claude",
			confidence: summary.confidence,
			rationale: `Routing to Claude for ${summary.actionItems.length} action item(s)${targetContext}.`,
			actionForSeed: summary.actionItems[0] || "execute task",
		}, summary);
	}

	const backend = routeByKeywords(summary);
	return withRouteMetadata({
		dispatch: true,
		backend,
		reason: backend === "codex" ? "dispatch-codex" : "dispatch-pi",
		confidence: Math.min(1, summary.confidence + (backend === "codex" ? 0.03 : 0)),
		rationale: backend === "codex"
			? `Routing to Codex because the action likely touches files.${targetContext}`
			: `Routing to Pi for planning/analysis on ${summary.actionItems.length} action item(s).${targetContext}`,
		actionForSeed: summary.actionItems[0] || "execute task",
	}, summary);
}

function describeBackend(backend: "pi" | "codex" | "claude" | "oh-my-pi") {
	if (backend === "codex") return "Codex";
	if (backend === "claude") return "Claude";
	if (backend === "oh-my-pi") return "Oh-my-pi";
	return "Pi";
}
