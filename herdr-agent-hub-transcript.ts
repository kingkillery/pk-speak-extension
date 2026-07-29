// herdr-agent-hub-transcript.ts — distills an oh-my-pk session jsonl transcript into a
// compact, speech-friendly digest for hub review. Pure module: takes text, returns data,
// no I/O. Parse-not-validate like the rest of the hub boundary — malformed lines are
// skipped, never thrown.
//
// Record shapes (verified against production transcripts):
//   { type: "session", id, version, timestamp, cwd, title }          — record 0
//   { type: "model_change", model, timestamp }
//   { type: "message", id, parentId, timestamp, message: { role, content: [...] } }
//     content items: { type: "text", text } | { type: "thinking", ... } |
//                    { type: "toolCall", id, name, arguments }
//     toolResult messages: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] }

export interface TranscriptToolCall {
	readonly name: string;
	/** Distilled, redacted argument summary (~120 chars max) — never the raw arguments blob. */
	readonly summary: string;
}

export interface TranscriptTurn {
	readonly at?: string;
	readonly role: "user" | "assistant" | "toolResult";
	/** Joined text parts, capped. Absent when the turn had no visible text. */
	readonly text?: string;
	/** toolResult turns only: the tool whose result this is. */
	readonly toolName?: string;
	/** toolResult turns only: true when the tool reported an error. */
	readonly isError?: boolean;
	/** assistant turns only: tool calls made in this turn. */
	readonly toolCalls?: readonly TranscriptToolCall[];
	/** Presence flag only — thinking content is never included in the digest. */
	readonly hasThinking?: boolean;
}

export interface TranscriptDigest {
	readonly sessionId?: string;
	readonly title?: string;
	readonly cwd?: string;
	/** Latest model_change seen, when any. */
	readonly model?: string;
	readonly turns: readonly TranscriptTurn[];
	readonly stats: {
		readonly messages: number;
		readonly toolCalls: number;
		readonly toolErrors: number;
		readonly filesTouched: readonly string[];
	};
	/** True when older turns were dropped to honour maxTurns (or the source text was a mid-file tail). */
	readonly truncated: boolean;
	/** Set when the digest was produced through filterDigestTurns. */
	readonly turnFilter?: { readonly query: string; readonly matched: number };
}

export interface ParseSessionTranscriptOptions {
	/** Keep only the last N turns. Default 40. */
	readonly maxTurns?: number;
	/** Per-turn visible-text cap. Default 400 chars. */
	readonly maxTextChars?: number;
	/** Cap for stats.filesTouched. Default 25. */
	readonly maxFilesTouched?: number;
}

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_TEXT_CHARS = 400;
const DEFAULT_MAX_FILES_TOUCHED = 25;
const TOOL_ARG_SUMMARY_CAP = 120;

const SECRET_KEY_PATTERN = /key|token|secret|password|credential|auth/i;

/**
 * Conservative value-level credential scrub. Key-name redaction alone misses the
 * common leak shapes found by the review: a Bearer token inside a bash command, an
 * sk- literal in eval code, a .env-style assignment in tool-result text. Every
 * digest-emitted string passes through this BEFORE capping. Tight patterns only —
 * the cost of a false positive is a redaction marker, the cost of a miss is a key
 * in tool output, which the repo's credentials contract forbids.
 */
export function redactCredentialValues(text: string): string {
	return text
		.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted-private-key]")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
		.replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[redacted-key]")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted-key]")
		.replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)(\s*[:=]\s*)["']?[^\s,"']{6,}/gi, "$1$2[redacted]");
}

/** Recursive secret-shaped key redaction for tool argument objects (env/headers nest). */
function redactSecretKeysDeep(value: unknown, depth: number): unknown {
	if (depth > 6) return value;
	if (Array.isArray(value)) return value.map((item) => redactSecretKeysDeep(item, depth + 1));
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactSecretKeysDeep(child, depth + 1);
	}
	return out;
}
const PATH_KEYS: Record<string, true> = {
	path: true, file: true, filepath: true, file_path: true, cwd: true, directory: true, dir: true, root: true,
	sessionpath: true, session_path: true, sessionfile: true, session_file: true, targetpath: true, target_path: true,
	projectpath: true, project_path: true, workdir: true, workingdirectory: true, working_directory: true, currentrepo: true,
};

// Real-transcript audit (222 production sessions): path-keyed args also carry skill://
// URIs, qmd docids ("#662eda"), and other non-filesystem values — exclude those shapes.
const URI_VALUE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_TOUCHED_FILE_CHARS = 300;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function capText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}…`;
}

/** Redacts secret-shaped values, then renders a compact one-line summary of tool arguments. */
export function distillToolCallSummary(name: string, args: unknown): string {
	if (!isRecord(args)) return "";
	const redacted = redactSecretKeysDeep(args, 0) as Record<string, unknown>;
	let primary: string | undefined;
	switch (name) {
		case "bash":
			primary = typeof redacted.command === "string" ? redacted.command : undefined;
			break;
		case "read":
		case "write":
		case "edit":
			primary = typeof redacted.path === "string" ? redacted.path : undefined;
			break;
		case "eval": {
			const language = typeof redacted.language === "string" ? redacted.language : "code";
			const label = typeof redacted.title === "string"
				? redacted.title
				: typeof redacted.code === "string"
					? redacted.code.replace(/\s+/g, " ").trim().slice(0, 60)
					: "";
			primary = label ? `${language}: ${label}` : language;
			break;
		}
		default:
			break;
	}
	if (primary) return capText(redactCredentialValues(primary.replace(/\s+/g, " ").trim()), TOOL_ARG_SUMMARY_CAP);
	try {
		return capText(redactCredentialValues(JSON.stringify(redacted)), TOOL_ARG_SUMMARY_CAP);
	} catch {
		return "";
	}
}

/** Collects path-shaped tool argument values (sessionFile, path, cwd, …) for cross-lane review. */
function collectTouchedFiles(args: unknown, into: Set<string>): void {
	if (!isRecord(args)) return;
	for (const [key, value] of Object.entries(args)) {
		if (SECRET_KEY_PATTERN.test(key)) continue;
		if (typeof value === "string" && value && value.length <= MAX_TOUCHED_FILE_CHARS && PATH_KEYS[key.toLowerCase()]) {
			if (URI_VALUE_PATTERN.test(value) || value.startsWith("#")) continue;
			into.add(value);
		}
	}
}

interface MutableTurn {
	at?: string;
	role: "user" | "assistant" | "toolResult";
	textParts: string[];
	toolName?: string;
	isError?: boolean;
	toolCalls: TranscriptToolCall[];
	hasThinking: boolean;
}

function freezeTurn(turn: MutableTurn, maxTextChars: number): TranscriptTurn {
	const text = turn.textParts.join("\n").trim();
	return {
		...(turn.at ? { at: turn.at } : {}),
		role: turn.role,
		...(text ? { text: capText(redactCredentialValues(text), maxTextChars) } : {}),
		...(turn.toolName ? { toolName: turn.toolName } : {}),
		...(turn.isError !== undefined ? { isError: turn.isError } : {}),
		...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
		...(turn.hasThinking ? { hasThinking: true } : {}),
	};
}

/**
 * Parses session jsonl text into a distilled digest. Tolerates a mid-file tail (the
 * session header may be absent) — callers that know the lane metadata should fill in
 * sessionId/cwd themselves when missing.
 */
export function parseSessionTranscript(
	jsonl: string,
	options: ParseSessionTranscriptOptions = {},
): TranscriptDigest {
	const maxTurns = clampInt(options.maxTurns, DEFAULT_MAX_TURNS, 1, 500);
	const maxTextChars = clampInt(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 40, 4_000);
	const maxFiles = clampInt(options.maxFilesTouched, DEFAULT_MAX_FILES_TOUCHED, 1, 100);

	let sessionId: string | undefined;
	let title: string | undefined;
	let cwd: string | undefined;
	let model: string | undefined;
	let messages = 0;
	let toolCallCount = 0;
	let toolErrors = 0;
	const filesTouched = new Set<string>();
	const turns: MutableTurn[] = [];

	for (const line of jsonl.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let record: unknown;
		try {
			record = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;

		if (record.type === "session") {
			if (typeof record.id === "string") sessionId = record.id;
			if (typeof record.title === "string") title = record.title;
			if (typeof record.cwd === "string") cwd = record.cwd;
			continue;
		}
		if (record.type === "model_change") {
			if (typeof record.model === "string") model = record.model;
			continue;
		}
		if (record.type !== "message" || !isRecord(record.message)) continue;

		const message = record.message;
		const role = message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
		messages += 1;

		const turn: MutableTurn = {
			at: typeof record.timestamp === "string"
				? record.timestamp
				: typeof message.timestamp === "string" ? message.timestamp : undefined,
			role,
			textParts: [],
			toolCalls: [],
			hasThinking: false,
		};

		if (role === "toolResult") {
			if (typeof message.toolName === "string") turn.toolName = message.toolName;
			turn.isError = message.isError === true;
			if (turn.isError) toolErrors += 1;
		}

		const content = message.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (!isRecord(item)) continue;
				if (item.type === "text" && typeof item.text === "string") {
					turn.textParts.push(item.text);
				} else if (item.type === "thinking") {
					turn.hasThinking = true;
				} else if (item.type === "toolCall" && typeof item.name === "string") {
					toolCallCount += 1;
					turn.toolCalls.push({ name: item.name, summary: distillToolCallSummary(item.name, item.arguments) });
					if (filesTouched.size < maxFiles) collectTouchedFiles(item.arguments, filesTouched);
				}
			}
		}
		turns.push(turn);
	}

	const dropped = Math.max(0, turns.length - maxTurns);
	const kept = dropped > 0 ? turns.slice(-maxTurns) : turns;
	return {
		...(sessionId ? { sessionId } : {}),
		...(title ? { title } : {}),
		...(cwd ? { cwd } : {}),
		...(model ? { model } : {}),
		turns: kept.map((turn) => freezeTurn(turn, maxTextChars)),
		stats: {
			messages,
			toolCalls: toolCallCount,
			toolErrors,
			filesTouched: [...filesTouched],
		},
		truncated: dropped > 0,
	};
}

/**
 * Case-insensitive substring filter over distilled turns (text, tool names, tool-call
 * summaries). Stats keep describing the full digest; the filter is reported separately.
 */
export function filterDigestTurns(digest: TranscriptDigest, query: string): TranscriptDigest {
	const needle = query.trim().toLowerCase();
	if (!needle) return digest;
	const matched = digest.turns.filter((turn) => {
		if (turn.text?.toLowerCase().includes(needle)) return true;
		if (turn.toolName?.toLowerCase().includes(needle)) return true;
		return turn.toolCalls?.some(
			(call) => call.name.toLowerCase().includes(needle) || call.summary.toLowerCase().includes(needle),
		) ?? false;
	});
	return { ...digest, turns: matched, turnFilter: { query: query.trim(), matched: matched.length } };
}
