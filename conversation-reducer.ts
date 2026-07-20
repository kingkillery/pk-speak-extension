import { isGeminiLiveConfigured, isGeminiLiveSimulated, runGeminiTextTurn } from "./gemini-live-turn.js";
import type { ConversationReducerSummary } from "./remote-turn-manager.js";

const DEFAULT_MIN_CONFIDENCE = 0.45;
const DEFAULT_GEMINI_TIMEOUT_MS = 6000;
const DEFAULT_OPENAI_TIMEOUT_MS = 1500;
const DEFAULT_OPENAI_ROUTER_MODEL = process.env.PI_SPEAK_ROUTER_MODEL || "gpt-5-nano";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

type ReducerMode = "off" | "heuristic" | "auto" | "gemini" | "openai";

export type ConversationReductionResult = {
	summary: ConversationReducerSummary;
	promptForAgent: string;
	replyText: string;
	dispatch: boolean;
	reducerMs: number;
};

export type ConversationReductionOptions = {
	source?: string;
	targetName?: string;
	minConfidence?: number;
	mode?: ReducerMode;
	timeoutMs?: number;
};

function getReducerMode() {
	const mode = (process.env.PI_SPEAK_REDUCER_MODE || "heuristic").trim().toLowerCase();
	if (mode === "off" || mode === "heuristic" || mode === "auto" || mode === "gemini" || mode === "openai") {
		return mode as ReducerMode;
	}
	return "heuristic" as const;
}

function getOpenAiRouterKey() {
	return process.env.PI_SPEAK_ROUTER_OPENAI_KEY || process.env.OPENAI_API_KEY || "";
}

function getOpenAiBaseUrl() {
	return (process.env.PI_SPEAK_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/g, "");
}

function getOpenAiRouterModels() {
	const configured = process.env.PI_SPEAK_ROUTER_MODELS || process.env.PI_SPEAK_ROUTER_MODEL || DEFAULT_OPENAI_ROUTER_MODEL;
	return configured
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function buildOpenAiCompatibleHeaders(apiKey: string) {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
	const referer = process.env.PI_SPEAK_HTTP_REFERER || process.env.OPENROUTER_HTTP_REFERER || "https://github.com/kingkillery/pk-speak-extension";
	const title = process.env.PI_SPEAK_APP_TITLE || process.env.OPENROUTER_APP_TITLE || "pk-speak-extension";
	if (referer) headers["HTTP-Referer"] = referer;
	if (title) headers["X-Title"] = title;
	return headers;
}

function getMinConfidence() {
	const parsed = Number.parseFloat(process.env.PI_SPEAK_REDUCER_MIN_CONFIDENCE || String(DEFAULT_MIN_CONFIDENCE));
	return Number.isFinite(parsed) ? parsed : DEFAULT_MIN_CONFIDENCE;
}

function toWords(value: string) {
	return value
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.filter(Boolean);
}

function splitSentences(value: string) {
	return value
		.split(/[.!?]+/g)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function isVoiceSource(source?: string) {
	return source === "http-voice" || source === "telegram-voice";
}

function collapseAdjacentRepeatedWords(value: string) {
	return value.replace(/\b([a-z0-9_]+)(?:\s+\1\b)+/gi, "$1");
}

function stripLeadingWakeAndFiller(value: string) {
	let out = value.trim();
	let changed = true;
	const leadingPatterns = [
		/^(?:hey|yo)\s+(?:pi|pie|pk|p\s*k|pi\s+speak|pie\s+speak|peace\s+speak)[\s,;:.-]+/i,
		/^(?:pi|pie|pk|p\s*k|pi\s+speak|pie\s+speak|peace\s+speak)[\s,;:.-]+/i,
		/^(?:um+|uh+|erm+|hmm+|mm+|okay|ok|alright|all right|so|actually|basically|like|you know)[\s,;:.-]+/i,
		/^(?:can you|could you|would you|i need you to|i want you to|please)[\s,;:.-]+/i,
	];
	while (changed) {
		changed = false;
		for (const pattern of leadingPatterns) {
			const next = out.replace(pattern, "").trim();
			if (next !== out) {
				out = next;
				changed = true;
			}
		}
	}
	return out;
}

function normalizeVoiceTranscript(text: string) {
	const normalized = text
		.replace(/\u00a0/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) {
		return { text: "", discarded: [] as string[] };
	}
	const sentences = splitSentences(normalized);
	const cleanedSentences: string[] = [];
	const discarded: string[] = [];
	for (const sentence of sentences.length ? sentences : [normalized]) {
		const collapsed = collapseAdjacentRepeatedWords(sentence.replace(/\s+/g, " ").trim());
		const cleaned = stripLeadingWakeAndFiller(collapsed);
		const lowered = cleaned.toLowerCase();
		if (!cleaned || /^(?:um+|uh+|erm+|hmm+|mm+|okay|ok|alright|all right|so|thanks|thank you|never mind|nevermind|cancel that|ignore that)$/i.test(cleaned)) {
			discarded.push(sentence);
			continue;
		}
		if (/^(?:transcript unavailable|listening|silence|background noise)$/i.test(lowered)) {
			discarded.push(sentence);
			continue;
		}
		cleanedSentences.push(cleaned);
		if (cleaned !== sentence.trim()) {
			discarded.push(sentence);
		}
	}
	return {
		text: cleanedSentences.join(". ").trim(),
		discarded: uniqueItems(discarded),
	};
}

function uniqueItems(values: string[]) {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of values) {
		const value = raw.trim().replace(/\s+/g, " ");
		if (!value) continue;
		const normalized = value.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(value);
	}
	return out;
}

function extractQuotedOrClause(value: string, prefix: RegExp, fullPrefix = "") {
	const match = value.toLowerCase().match(prefix);
	if (!match) return undefined;
	const start = match.index ? match.index : 0;
	const sentence = value.slice(start + match[0].length).trim();
	if (!sentence) return undefined;
	return `${fullPrefix}${sentence}`.trim();
}

function extractConstraints(words: string[], sentences: string[]) {
	const out: string[] = [];
	const constraintRegex = /\b(without|except|avoid|unless|only if|do not|don't|no|never|must|mustn't|unless)\b/i;
	for (const sentence of sentences) {
		if (constraintRegex.test(sentence)) {
			out.push(sentence);
		}
	}
	for (const clause of sentences) {
		const lowered = clause.toLowerCase();
		if (lowered.includes("if ") && lowered.includes("then")) out.push(clause);
	}
	return uniqueItems(out);
}

function detectDoNot(items: string[]) {
	const out: string[] = [];
	for (const item of items) {
		const lowered = item.toLowerCase();
		if (/\b(don't|do not|never|avoid|not now|skip that|ignore)\b/.test(lowered)) {
			out.push(item);
		}
	}
	return uniqueItems(out);
}

function detectReminders(values: string[]) {
	const out: string[] = [];
	for (const value of values) {
		const lowered = value.toLowerCase();
		if (/\b(remind me|hold this|later|someday|for later|remember)\b/.test(lowered)) {
			out.push(value);
		}
	}
	return uniqueItems(out);
}

function detectUnknowns(values: string[]) {
	const out: string[] = [];
	for (const value of values) {
		const lowered = value.toLowerCase();
		if (/\b(i'm not sure|not sure|i am not sure|uncertain|need more context|i don't know)\b/.test(lowered)) {
			out.push(value);
		}
	}
	return uniqueItems(out);
}

function detectActionItems(sentences: string[]) {
	const out: string[] = [];
	for (const sentence of sentences) {
		const lowered = sentence.toLowerCase();
		if (
			/\b(create|add|remove|delete|edit|refactor|fix|implement|update|change|open|run|check|inspect|find|build|deploy|ship|test|pair|pair with|route|set|switch|rename|move|clean|audit|explain|show)\b/.test(lowered)
		) {
			out.push(sentence);
		}
	}
	return uniqueItems(out);
}

function detectDiscarded(sentences: string[], source?: string, targetName?: string) {
	const discarded: string[] = [];
	const noise = [
		/^(hi|hey|hello|thanks|thank you|cool|ok|okay|great|sounds good|alright|yep|yes|no|mm|hmm)\b/i,
		/^(sounds good|i see|roger|got it|works for me|nice)\b/i,
	];
	for (const sentence of sentences) {
		if (noise.some((pattern) => pattern.test(sentence.trim().toLowerCase()))) {
			discarded.push(sentence);
			continue;
		}
		if (targetName && !targetName.trim() && /\broute to current\b/i.test(sentence)) {
			discarded.push(sentence);
			continue;
		}
		if (source === "telegram-voice") {
			if (/^um+$/i.test(sentence.trim()) || /^hmm+$/i.test(sentence.trim())) {
				discarded.push(sentence);
			}
		}
	}
	return uniqueItems(discarded);
}

function estimateConfidence(text: string, actionItems: string[], discarded: string[]) {
	const words = toWords(text);
	if (words.length < 2) return 0.05;
	let score = 0.3;
	if (actionItems.length > 0) score += 0.35;
	if (/\b(please|can you|could you|i want|please do|add|fix|build|ship|inspect|test|check)\b/i.test(text)) score += 0.2;
	if (/\b(what|how|why|should|can i|could i|please)\b/i.test(text)) score += 0.08;
	if (discarded.length >= Math.max(2, Math.ceil(words.length / 8))) score -= 0.2;
	if (!/[a-z]/i.test(text)) score -= 0.5;
	return Math.max(0, Math.min(1, score));
}

function buildHeuristicSummary(text: string, source?: string, targetName?: string, minConfidence = DEFAULT_MIN_CONFIDENCE): {
	summary: ConversationReducerSummary;
	text: string;
	actionItems: string[];
	constraints: string[];
} {
	const voicePrepared = isVoiceSource(source) ? normalizeVoiceTranscript(text) : undefined;
	const normalized = (voicePrepared?.text || text).trim().replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
	const sentences = splitSentences(normalized);
	const goal = sentences[0] || normalized.slice(0, 120);
	const actionItems = detectActionItems(sentences);
	const constraints = extractConstraints([], sentences);
	const doNot = detectDoNot(sentences);
	const reminders = detectReminders(sentences);
	const unknowns = detectUnknowns(sentences);
	const discarded = uniqueItems([...(voicePrepared?.discarded || []), ...detectDiscarded(sentences, source, targetName)]);
	const confidence = estimateConfidence(normalized, actionItems, discarded);
	const shouldDispatch = normalized.length > 0 && confidence >= minConfidence && actionItems.length > 0;
	return {
		summary: {
			goal: goal ? goal.trim() : text,
			actionItems: uniqueItems(actionItems),
			constraints: uniqueItems(constraints),
			deferredReminders: uniqueItems(reminders),
			doNotDo: uniqueItems(doNot),
			unknowns: uniqueItems(unknowns),
			discarded: uniqueItems(discarded),
			confidence,
			shouldDispatch,
			clarifyingQuestion: shouldDispatch
				? undefined
				: "I need one concrete action item. What exactly should I do?",
			engine: "heuristic" as const,
		},
		text: normalized,
		actionItems,
		constraints,
	};
}

function parseJsonPayload(raw: string) {
	const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
	const jsonLike = fenced?.[1] || raw;
	const start = jsonLike.indexOf("{");
	const end = jsonLike.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(jsonLike.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

function asStringList(value: unknown) {
	if (!Array.isArray(value)) return [];
	return uniqueItems(value.filter((item) => typeof item === "string"));
}

function coerceConfidence(value: unknown, fallback: number) {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value || ""));
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(0, Math.min(1, parsed));
}

function coerceBoolean(value: unknown, fallback: boolean) {
	return typeof value === "boolean" ? value : fallback;
}

async function reduceWithGemini(text: string, options: ConversationReductionOptions, heuristic: ReturnType<typeof buildHeuristicSummary>) {
	const prompt = [
		"You are a strict conversation reducer for a coding assistant command loop.",
		"Return strict JSON only.",
		'Schema: {"goal":"", "actionItems":[],"constraints":[],"deferredReminders":[],"doNotDo":[],"unknowns":[],"clarifyingQuestion":"","shouldDispatch":true,"confidence":0.0}',
		'Use doNotDo for explicitly rejected ideas and constraints for rules.',
		"If there is no clear next action, set shouldDispatch=false and include a short clarifyingQuestion.",
		"Keep output as concise as possible.",
		"",
		`Transcript: ${text}`,
	].join("\n");

	const llmResult = await runGeminiTextTurn(prompt, {
		timeoutMs: options.timeoutMs || DEFAULT_GEMINI_TIMEOUT_MS,
	});
	const payload = parseJsonPayload(llmResult.replyText || "");
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return heuristic;
	}
	const shouldDispatch = coerceBoolean(payload.shouldDispatch, heuristic.summary.shouldDispatch);
	const confidence = coerceConfidence(payload.confidence, heuristic.summary.confidence);
	const minConfidence = options.minConfidence || DEFAULT_MIN_CONFIDENCE;
	const merged: ConversationReducerSummary = {
		goal: typeof payload.goal === "string" && payload.goal.trim() ? payload.goal.trim() : heuristic.summary.goal,
		actionItems: uniqueItems(asStringList(payload.actionItems)),
		constraints: uniqueItems(asStringList(payload.constraints)),
		deferredReminders: uniqueItems(asStringList(payload.deferredReminders)),
		doNotDo: uniqueItems(asStringList(payload.doNotDo)),
		unknowns: uniqueItems(asStringList(payload.unknowns)),
		discarded: heuristic.summary.discarded,
		confidence,
		shouldDispatch: shouldDispatch && confidence >= minConfidence && asStringList(payload.actionItems).length > 0,
		clarifyingQuestion: shouldDispatch ? undefined : typeof payload.clarifyingQuestion === "string"
			? payload.clarifyingQuestion.trim()
			: undefined,
		engine: "gemini",
	};
	return { ...heuristic, summary: merged, actionItems: merged.actionItems, constraints: merged.constraints };
}

async function reduceWithOpenAI(text: string, options: ConversationReductionOptions, heuristic: ReturnType<typeof buildHeuristicSummary>) {
	const apiKey = getOpenAiRouterKey();
	if (!apiKey) return heuristic;
	for (const model of getOpenAiRouterModels()) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_OPENAI_TIMEOUT_MS);
		try {
			const response = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
				method: "POST",
				headers: buildOpenAiCompatibleHeaders(apiKey),
				body: JSON.stringify({
					model,
					temperature: 0,
					response_format: { type: "json_object" },
					messages: [
						{
							role: "system",
							content: [
								"You are a fast request router for a voice coding assistant.",
								"Return strict JSON only.",
								'Schema: {"goal":"", "actionItems":[],"constraints":[],"deferredReminders":[],"doNotDo":[],"unknowns":[],"clarifyingQuestion":"","shouldDispatch":true,"confidence":0.0}',
								"Dispatch only when there is a concrete action. Ask one short clarifying question otherwise.",
								"Favor concise eyes-free operation: preserve the concrete user action and omit filler.",
							].join("\n"),
						},
						{ role: "user", content: text.slice(0, 4000) },
					],
				}),
				signal: controller.signal,
			});
			if (!response.ok) continue;
			const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
			const payload = parseJsonPayload(json.choices?.[0]?.message?.content || "");
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
			const shouldDispatch = coerceBoolean(payload.shouldDispatch, heuristic.summary.shouldDispatch);
			const confidence = coerceConfidence(payload.confidence, heuristic.summary.confidence);
			const minConfidence = options.minConfidence || DEFAULT_MIN_CONFIDENCE;
			const actionItems = asStringList(payload.actionItems);
			const merged: ConversationReducerSummary = {
				goal: typeof payload.goal === "string" && payload.goal.trim() ? payload.goal.trim() : heuristic.summary.goal,
				actionItems: uniqueItems(actionItems),
				constraints: uniqueItems(asStringList(payload.constraints)),
				deferredReminders: uniqueItems(asStringList(payload.deferredReminders)),
				doNotDo: uniqueItems(asStringList(payload.doNotDo)),
				unknowns: uniqueItems(asStringList(payload.unknowns)),
				discarded: heuristic.summary.discarded,
				confidence,
				shouldDispatch: shouldDispatch && confidence >= minConfidence && actionItems.length > 0,
				clarifyingQuestion: shouldDispatch ? undefined : typeof payload.clarifyingQuestion === "string"
					? payload.clarifyingQuestion.trim()
					: undefined,
				engine: "openai",
			};
			return { ...heuristic, summary: merged, actionItems: merged.actionItems, constraints: merged.constraints };
		} catch {
			// Try the next configured fast router model, then fall back to heuristics.
		} finally {
			clearTimeout(timeout);
		}
	}
	return heuristic;
}

function normalizeSummary(summary: ConversationReducerSummary, fallbackText: string) {
	return {
		...summary,
		actionItems: uniqueItems(summary.actionItems),
		constraints: uniqueItems(summary.constraints),
		deferredReminders: uniqueItems(summary.deferredReminders),
		doNotDo: uniqueItems(summary.doNotDo),
		unknowns: uniqueItems(summary.unknowns),
		discarded: uniqueItems(summary.discarded),
		clarifyingQuestion: summary.clarifyingQuestion ? summary.clarifyingQuestion.trim() : undefined,
		goal: summary.goal.trim() || fallbackText,
	};
}

function buildPromptForAgent(summary: ConversationReducerSummary, transcript: string) {
	const parts: string[] = [];
	parts.push(`Goal: ${summary.goal}`);
	if (summary.actionItems.length > 0) {
		parts.push(`Action items:\n- ${summary.actionItems.join("\n- ")}`);
	}
	if (summary.constraints.length > 0) {
		parts.push(`Constraints:\n- ${summary.constraints.join("\n- ")}`);
	}
	if (summary.deferredReminders.length > 0) {
		parts.push(`Deferred reminders:\n- ${summary.deferredReminders.join("\n- ")}`);
	}
	if (summary.doNotDo.length > 0) {
		parts.push(`Do not do:\n- ${summary.doNotDo.join("\n- ")}`);
	}
	if (summary.unknowns.length > 0) {
		parts.push(`Open questions:\n- ${summary.unknowns.join("\n- ")}`);
	}
	parts.push(`Original transcript:\n${transcript}`);
	return parts.join("\n\n");
}

export async function reduceConversationTurn(
	text: string,
	options: ConversationReductionOptions = {},
): Promise<ConversationReductionResult> {
	const startedAt = Date.now();
	const normalized = text.trim();
	const source = options.source;
	const targetName = options.targetName;
	const minConfidence = options.minConfidence ?? getMinConfidence();
	const timeoutMs = options.timeoutMs || DEFAULT_GEMINI_TIMEOUT_MS;
	const reducerMode = options.mode || getReducerMode();
	const base = buildHeuristicSummary(normalized, source, targetName, minConfidence);
	const routerText = base.text || normalized;
	const shouldTryGemini = reducerMode === "gemini" || (reducerMode === "auto" && !getOpenAiRouterKey() && !reducedConfidenceDefaultEnough(routerText, source));
	const shouldTryOpenAI = reducerMode === "openai" || (reducerMode === "auto" && !!getOpenAiRouterKey() && !reducedConfidenceDefaultEnough(routerText, source));

	let best = base;
	if (reducerMode !== "off" && reducerMode !== "heuristic" && shouldTryOpenAI && routerText) {
		best = await reduceWithOpenAI(routerText, {
			mode: reducerMode,
			minConfidence,
			timeoutMs: Math.min(timeoutMs, DEFAULT_OPENAI_TIMEOUT_MS),
			source,
			targetName,
		}, base);
	}
	if (reducerMode !== "off" && reducerMode !== "heuristic" && shouldTryGemini && isGeminiLiveConfigured() && !isGeminiLiveSimulated() && routerText) {
		try {
			const geminiResult = await reduceWithGemini(routerText, {
				mode: reducerMode,
				minConfidence,
				timeoutMs,
				source,
				targetName,
			}, base);
			best = geminiResult;
		} catch {
			best = base;
		}
	}

	const summary = normalizeSummary(best.summary, normalized);
	const normalizedDispatch = summary.shouldDispatch && summary.actionItems.length > 0;
	const replyText = normalizedDispatch
		? ""
		: summary.clarifyingQuestion || "I need a clearer action before I can dispatch that.";
	const promptForAgent = buildPromptForAgent(summary, normalized);
	return {
		summary,
		promptForAgent,
		replyText,
		dispatch: normalizedDispatch,
		reducerMs: Date.now() - startedAt,
	};
}

function reducedConfidenceDefaultEnough(text: string, source?: string) {
	if (!text || !text.trim()) return false;
	const base = buildHeuristicSummary(text, source, undefined, getMinConfidence());
	return base.summary.confidence >= getMinConfidence();
}
