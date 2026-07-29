// herdr-agent-hub-review.ts — composes the prompt for a hub review lane: a background
// oh-my-pk agent that answers a review question by reading sibling lanes' session
// transcripts. Pure module: no I/O, fully unit-testable. The composed prompt is frozen
// into the launch approval args, so the operator-approved launch executes exactly this
// text. The FIRST LINE doubles as the review lane's discoverable session title.

import type { HubAgent } from "./herdr-agent-hub-schema.js";

export interface BuildHubReviewPromptOptions {
	readonly question: string;
	readonly lanes: readonly HubAgent[];
	/** Cap on inventory lines; remaining lanes are summarized by count. Default 30. */
	readonly maxLanes?: number;
}

const DEFAULT_MAX_LANES = 30;

function singleLine(text: string, cap: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

/**
 * Builds the review-lane prompt. The lane is a normal background agent with ordinary
 * file tools — the prompt's job is to give it the lane inventory (with transcript
 * paths, so it never has to discover the sessions root), the transcript format, the
 * bounded-read rule (transcripts can be hundreds of MB), and the verdict format voice
 * will read back through read_agent_transcript.
 */
export function buildHubReviewPrompt(options: BuildHubReviewPromptOptions): string {
	const question = options.question.trim();
	const maxLanes = Math.min(Math.max(Math.trunc(options.maxLanes ?? DEFAULT_MAX_LANES), 1), 200);
	const ranked = [...options.lanes].sort((a, b) => a.id.localeCompare(b.id));
	const shown = ranked.slice(0, maxLanes);
	const inventory = shown
		.map((lane) => `- ${lane.id} | ${lane.kind} | ${lane.status} | ${lane.cwd ?? "unknown cwd"} | ${lane.sessionFile ?? "no transcript"}`)
		.join("\n");
	const overflow = ranked.length - shown.length;

	return `Hub review: ${singleLine(question, 100)}

You are a review lane inside the pk-herdr agent hub. Your only job is to answer the review question below by inspecting the session transcripts of the sibling lanes in the inventory. Work strictly read-only: never modify files in other lanes' workspaces, never message, kill, or revive other lanes.

REVIEW QUESTION
${question}

LANE INVENTORY (id | kind | status | cwd | transcript path)
${inventory || "- (hub is empty — no lanes to inspect)"}${overflow > 0 ? `\n- …and ${overflow} more lanes omitted from this inventory` : ""}

TRANSCRIPT FORMAT
- Each transcript is JSONL: one JSON record per line, and files can be hundreds of MB.
- Record 0 is {"type":"session", id, cwd, title, ...}. Turns are {"type":"message", timestamp, message:{role, content:[...]}} where role is "user", "assistant", or "toolResult", and content items are {type:"text"}, {type:"thinking"}, or {type:"toolCall", name, arguments}.
- {"type":"model_change", model} records track model switches; {"type":"background_instance", ...} marks background lanes.

RULES
- NEVER read a whole transcript file. Read bounded tails and search for keywords (e.g. grep-style) — a full read of a large transcript can exhaust memory.
- Inspect only the lanes needed to answer the question, and keep track of which ones you read.
- If a transcript is missing, unreadable, or too large to sample meaningfully, say so — do not guess.
- Ignore records of other types (system injections, custom UI messages); they are not lane turns.

OUTPUT FORMAT
End your final message with exactly these three sections:
VERDICT: <2-4 sentence answer to the review question>
EVIDENCE: <what you observed, per lane, with timestamps where relevant>
CAVEATS: <what you could not verify>`;
}
