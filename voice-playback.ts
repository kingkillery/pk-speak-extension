import { normalizeVoiceRouteKey } from "./voice-routing.js";

// Voice playback commands.
//
// Extractive-only operations over the saved last assistant reply. No LLM
// round-trip per command (no context rot): the saved text is treated as the
// source of truth and we either replay it verbatim or run a regex over it.
//
// Pickup notes:
//   - parsePlaybackCommand returns the discrete intent so routeVoiceInput
//     stays the only place that knows about TTS state.
//   - extractErrors / extractDiff are deterministic. If they find nothing,
//     they return "" and the caller speaks a friendly fallback.

export type PlaybackCommand = "repeat" | "read-error" | "read-diff";

const REPEAT_PHRASES = new Set([
	"repeat",
	"repeat that",
	"repeat it",
	"say that again",
	"say it again",
	"read it again",
	"read that again",
	"play it again",
	"play that again",
	"what was that",
	"what did you say",
]);

const READ_ERROR_PHRASES = new Set([
	"read the error",
	"read the errors",
	"read errors",
	"read me the error",
	"read me the errors",
	"what was the error",
	"what were the errors",
	"what is the error",
	"read the last error",
]);

const READ_DIFF_PHRASES = new Set([
	"read the diff",
	"read the diffs",
	"read me the diff",
	"read the code",
	"read me the code",
	"read the patch",
	"read me the patch",
	"what was the diff",
	"what is the diff",
	"what was the code",
]);

export function parsePlaybackCommand(text: string): PlaybackCommand | undefined {
	const normalized = normalizeVoiceRouteKey(text);
	if (!normalized) return undefined;
	if (REPEAT_PHRASES.has(normalized)) return "repeat";
	if (READ_ERROR_PHRASES.has(normalized)) return "read-error";
	if (READ_DIFF_PHRASES.has(normalized)) return "read-diff";
	return undefined;
}

// Substring match (no \b boundaries) so compound forms like TypeError,
// RuntimeError, AssertionError, EACCES_FAILED also count.
const ERROR_KEYWORDS = /(error|exception|failed|failure|panic|traceback|stack ?trace|fatal)/i;

// Returns up to maxChars of error-flavoured lines, joined by newlines.
// Each match includes one line of leading context so file:line headers
// like "  at foo.ts:42:13" stay attached to their error message.
export function extractErrors(text: string, maxChars = 800): string {
	if (!text) return "";
	const lines = text.split(/\r?\n/);
	const collected: string[] = [];
	let total = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!ERROR_KEYWORDS.test(line)) continue;
		const candidate = i > 0 && lines[i - 1].trim() ? `${lines[i - 1]}\n${line}` : line;
		if (total + candidate.length > maxChars) break;
		collected.push(candidate);
		total += candidate.length + 1;
	}
	return collected.join("\n").trim();
}

// Returns the first fenced code block (or unified diff) found in the text,
// stripped of fence markers. Empty string when no block is present.
export function extractDiff(text: string, maxChars = 1200): string {
	if (!text) return "";

	// Triple-backtick fenced blocks. Capture the body without the fence/lang.
	const fenced = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
	if (fenced && fenced[1]) {
		const body = fenced[1].trim();
		return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
	}

	// Unified-diff signature: a contiguous run of lines starting with
	// +++ / --- / @@ / leading + or -. Cheap heuristic; good enough for
	// patches the agent emits inline.
	const lines = text.split(/\r?\n/);
	let start = -1;
	let end = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^(?:\+\+\+|---|@@) /.test(lines[i])) {
			if (start === -1) start = i;
			end = i;
			continue;
		}
		if (start !== -1 && /^[+-]/.test(lines[i])) {
			end = i;
		}
	}
	if (start !== -1 && end > start) {
		const body = lines.slice(start, end + 1).join("\n").trim();
		return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
	}

	return "";
}
