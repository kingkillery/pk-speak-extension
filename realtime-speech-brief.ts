/**
 * Shape realtime tool results for spoken conversation.
 *
 * The Live model should *discuss* findings, not recite dumps. Call sites still
 * keep the raw tool payload for the client (`tool_complete`); only the
 * model-facing FunctionResponse goes through this shaper.
 */

export const SPEECH_TEXT_CAP = 1_600;
export const SPEECH_LINE_CAP = 40;
export const SPEECH_LIST_CAP = 25;
export const SPEECH_PASS_THROUGH_MAX = 240;

export const DEFAULT_SPEECH_HINT =
	"Discuss findings conversationally. Never read JSON, raw dumps, or long excerpts aloud. Summarize what matters, quote at most one short phrase when useful, and ask if the user wants more detail.";

export type ClippedSpeechText = {
	text: string;
	truncated: boolean;
	originalLength: number;
};

export function clipSpeechText(text: string, cap = SPEECH_TEXT_CAP): ClippedSpeechText {
	const normalized = String(text ?? "").replace(/\r\n/g, "\n");
	if (normalized.length <= cap) {
		return { text: normalized, truncated: false, originalLength: normalized.length };
	}
	// Prefer a clean cut near a newline when possible.
	const sliceAt = normalized.lastIndexOf("\n", cap - 20);
	const cut = sliceAt >= Math.floor(cap * 0.6) ? sliceAt : cap;
	return {
		text: `${normalized.slice(0, cut).trimEnd()}\n…[truncated for speech]`,
		truncated: true,
		originalLength: normalized.length,
	};
}

function clipLines(text: string, maxLines = SPEECH_LINE_CAP, cap = SPEECH_TEXT_CAP): ClippedSpeechText {
	const normalized = String(text ?? "").replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const lineTrimmed = lines.length > maxLines
		? [...lines.slice(0, maxLines), `…[${lines.length - maxLines} more lines omitted]`].join("\n")
		: normalized;
	const clipped = clipSpeechText(lineTrimmed, cap);
	return {
		text: clipped.text,
		truncated: clipped.truncated || lines.length > maxLines,
		originalLength: normalized.length,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function capArray<T>(items: T[], cap = SPEECH_LIST_CAP): { items: T[]; truncated: boolean; total: number } {
	if (!Array.isArray(items)) return { items: [], truncated: false, total: 0 };
	if (items.length <= cap) return { items, truncated: false, total: items.length };
	return { items: items.slice(0, cap), truncated: true, total: items.length };
}

function terminalSummary(obj: Record<string, unknown>): string {
	const ok = obj.ok === true;
	const code = typeof obj.code === "number" ? obj.code : undefined;
	const command = typeof obj.command === "string" ? obj.command : undefined;
	const stdout = typeof obj.stdout === "string" ? obj.stdout.trim() : "";
	const stderr = typeof obj.stderr === "string" ? obj.stderr.trim() : "";
	const lastOut = stdout ? stdout.split(/\r?\n/).filter(Boolean).slice(-2).join(" · ") : "";
	const errBit = stderr ? stderr.split(/\r?\n/).filter(Boolean).slice(0, 1).join("") : "";
	const parts: string[] = [];
	parts.push(ok ? "Command succeeded" : "Command failed");
	if (code !== undefined) parts.push(`exit ${code}`);
	if (command) parts.push(`(${clipSpeechText(command, 80).text})`);
	if (errBit) parts.push(`error: ${clipSpeechText(errBit, 120).text}`);
	else if (lastOut) parts.push(`output: ${clipSpeechText(lastOut, 160).text}`);
	return parts.join(" — ");
}

function shapeTerminal(obj: Record<string, unknown>): Record<string, unknown> {
	const next = { ...obj };
	if (typeof next.stdout === "string") {
		const clipped = clipLines(next.stdout);
		next.stdout = clipped.text;
		if (clipped.truncated) next.stdoutTruncated = true;
		next.stdoutOriginalLength = clipped.originalLength;
	}
	if (typeof next.stderr === "string") {
		const clipped = clipLines(next.stderr);
		next.stderr = clipped.text;
		if (clipped.truncated) next.stderrTruncated = true;
		next.stderrOriginalLength = clipped.originalLength;
	}
	next.summary = typeof next.summary === "string" ? next.summary : terminalSummary(obj);
	return next;
}

function shapeWorkspaceFile(obj: Record<string, unknown>): Record<string, unknown> {
	const next = { ...obj };
	const file = isPlainObject(next.file) ? { ...next.file } : null;
	if (!file) return next;
	if (typeof file.content === "string") {
		const content = file.content;
		const clipped = clipLines(content);
		file.content = clipped.text;
		file.lineCount = content ? content.replace(/\r\n/g, "\n").split("\n").length : 0;
		file.contentOriginalLength = clipped.originalLength;
		if (clipped.truncated) {
			file.contentTruncatedForSpeech = true;
			file.truncated = true;
		}
		const fileName = typeof file.name === "string" ? file.name : "read";
		next.summary = `File ${fileName} — ${file.lineCount} lines${clipped.truncated ? ", preview only" : ""}`;
	} else if (file.binary) {
		next.summary = `Binary file ${typeof file.name === "string" ? file.name : ""}`.trim();
	}
	next.file = file;
	return next;
}

function shapeAgentDetail(obj: Record<string, unknown>): Record<string, unknown> {
	const next = { ...obj };
	const agent = isPlainObject(next.agent) ? { ...next.agent } : null;
	if (!agent) return next;

	for (const key of ["transcript", "tail", "log", "output", "recentOutput", "lastOutput"] as const) {
		const value = agent[key];
		if (typeof value === "string") {
			const clipped = clipLines(value);
			agent[key] = clipped.text;
			if (clipped.truncated) agent[`${key}TruncatedForSpeech`] = true;
		} else if (Array.isArray(value)) {
			const capped = capArray(value, SPEECH_LINE_CAP);
			agent[key] = capped.items.map((item) => {
				if (typeof item === "string") return clipSpeechText(item, 240).text;
				if (isPlainObject(item) && typeof item.text === "string") {
					return { ...item, text: clipSpeechText(item.text, 240).text };
				}
				if (isPlainObject(item) && typeof item.content === "string") {
					return { ...item, content: clipSpeechText(item.content, 240).text };
				}
				return item;
			});
			if (capped.truncated) agent[`${key}TruncatedForSpeech`] = true;
			agent[`${key}Total`] = capped.total;
		}
	}

	const name = typeof agent.name === "string" ? agent.name : typeof agent.id === "string" ? agent.id : "agent";
	const status = typeof agent.status === "string" ? agent.status : undefined;
	next.summary = status ? `Agent ${name} is ${status}.` : `Agent ${name}.`;
	next.agent = agent;
	return next;
}

function shapeTranscriptDigest(obj: Record<string, unknown>): Record<string, unknown> {
	const next = { ...obj };
	const transcript = isPlainObject(next.transcript) ? { ...next.transcript } : null;
	if (!transcript) return next;

	if (Array.isArray(transcript.turns)) {
		const capped = capArray(transcript.turns, SPEECH_LINE_CAP);
		transcript.turns = capped.items.map((turn) => {
			if (!isPlainObject(turn)) return turn;
			const t = { ...turn };
			if (typeof t.text === "string") t.text = clipSpeechText(t.text, 240).text;
			if (Array.isArray(t.toolCalls)) {
				const cappedCalls = capArray(t.toolCalls, 5);
				t.toolCalls = cappedCalls.items.map((call) =>
					isPlainObject(call) && typeof call.summary === "string"
						? { ...call, summary: clipSpeechText(call.summary, 120).text }
						: call);
			}
			return t;
		});
		if (capped.truncated) transcript.turnsTruncatedForSpeech = true;
	}

	const stats = isPlainObject(transcript.stats) ? transcript.stats : {};
	const who = typeof transcript.title === "string"
		? transcript.title
		: typeof transcript.sessionId === "string" ? transcript.sessionId : "agent";
	const parts = [`Transcript review for ${who}`];
	if (typeof stats.messages === "number") parts.push(`${stats.messages} messages`);
	if (typeof stats.toolCalls === "number") parts.push(`${stats.toolCalls} tool calls`);
	if (typeof stats.toolErrors === "number" && stats.toolErrors > 0) parts.push(`${stats.toolErrors} tool errors`);
	if (transcript.truncated === true) parts.push("older turns omitted");
	next.summary = parts.join(" — ");
	next.transcript = transcript;
	return next;
}

function shapeHubBriefing(obj: Record<string, unknown>): Record<string, unknown> {
	const next = { ...obj };
	const briefing = isPlainObject(next.briefing) ? { ...next.briefing } : null;
	if (!briefing) return next;

	const lanes = Array.isArray(briefing.lanes) ? briefing.lanes.filter(isPlainObject) : [];
	const capped = capArray(lanes, SPEECH_LINE_CAP);
	briefing.lanes = capped.items;
	if (capped.truncated) briefing.lanesTruncatedForSpeech = true;

	const agents = typeof briefing.agents === "number" ? briefing.agents : lanes.length;
	const folders = typeof briefing.folders === "number" ? briefing.folders : 0;
	const counts = isPlainObject(briefing.counts) ? briefing.counts : {};
	const countParts = ["running", "idle", "parked", "aborted"]
		.filter((status) => typeof counts[status] === "number" && (counts[status] as number) > 0)
		.map((status) => `${counts[status]} ${status}`);
	const parts = [`Hub briefing: ${agents} agent${agents === 1 ? "" : "s"}${folders > 0 ? ` in ${folders} folder${folders === 1 ? "" : "s"}` : ""}`];
	if (countParts.length > 0) parts.push(countParts.join(", "));
	// Lane mentions: error lanes first — those are what a standup needs to surface.
	const mentions = [...lanes]
		.sort((a, b) => (typeof b.recentToolErrors === "number" ? b.recentToolErrors : 0)
			- (typeof a.recentToolErrors === "number" ? a.recentToolErrors : 0))
		.slice(0, 5)
		.map((lane) => {
			const calls = typeof lane.recentToolCalls === "number" ? lane.recentToolCalls : 0;
			const errors = typeof lane.recentToolErrors === "number" ? lane.recentToolErrors : 0;
			const unavailable = lane.transcriptUnavailable === true ? ", transcript unavailable" : "";
			return `${lane.id}: ${lane.status}, ${calls} recent tool calls${errors > 0 ? `, ${errors} errors` : ""}${unavailable}`;
		});
	if (mentions.length > 0) parts.push(mentions.join(". "));
	if (briefing.lanesCapped === true) parts.push("remaining agents counted only");
	next.summary = parts.join(" — ");
	next.briefing = briefing;
	return next;
}

function shapeSessionDashboard(obj: Record<string, unknown>): Record<string, unknown> {
	const next = { ...obj };
	if (Array.isArray(next.workspaces)) {
		const cappedWorkspaces = capArray(next.workspaces, SPEECH_LIST_CAP);
		next.workspaces = cappedWorkspaces.items.map((workspace) => {
			if (!isPlainObject(workspace)) return workspace;
			const w = { ...workspace };
			if (Array.isArray(w.sessions)) {
				const capped = capArray(w.sessions, SPEECH_LIST_CAP);
				w.sessions = capped.items;
				if (capped.truncated) w.sessionsTruncatedForSpeech = true;
				w.sessionTotal = capped.total;
			}
			return w;
		});
		if (cappedWorkspaces.truncated) next.workspacesTruncatedForSpeech = true;
		next.workspaceTotal = cappedWorkspaces.total;
	}
	if (Array.isArray(next.agents)) {
		const capped = capArray(next.agents, SPEECH_LIST_CAP);
		next.agents = capped.items;
		if (capped.truncated) next.agentsTruncatedForSpeech = true;
		next.agentTotal = capped.total;
	}
	if (Array.isArray(next.folders)) {
		const capped = capArray(next.folders, SPEECH_LIST_CAP);
		next.folders = capped.items;
		if (capped.truncated) next.foldersTruncatedForSpeech = true;
	}
	if (Array.isArray(next.runningSnapshots)) {
		const capped = capArray(next.runningSnapshots, SPEECH_LIST_CAP);
		next.runningSnapshots = capped.items;
		if (capped.truncated) next.runningSnapshotsTruncatedForSpeech = true;
	}
	if (isPlainObject(next.workspace) && Array.isArray(next.workspace.entries)) {
		const workspace = { ...next.workspace };
		const capped = capArray(workspace.entries as unknown[], SPEECH_LIST_CAP);
		workspace.entries = capped.items;
		if (capped.truncated) workspace.entriesTruncatedForSpeech = true;
		workspace.entryTotal = capped.total;
		next.workspace = workspace;
		next.summary = `Workspace listing with ${capped.total} entr${capped.total === 1 ? "y" : "ies"}${capped.truncated ? " (preview)" : ""}.`;
	}
	return next;
}

function shapeGenericObject(obj: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string" && value.length > SPEECH_PASS_THROUGH_MAX) {
			const clipped = clipLines(value);
			next[key] = clipped.text;
			if (clipped.truncated) next[`${key}TruncatedForSpeech`] = true;
		} else if (Array.isArray(value) && value.length > SPEECH_LIST_CAP) {
			const capped = capArray(value);
			next[key] = capped.items;
			next[`${key}TruncatedForSpeech`] = true;
			next[`${key}Total`] = capped.total;
		} else if (isPlainObject(value)) {
			// One level only — avoid deep walks on huge graphs.
			const child: Record<string, unknown> = {};
			for (const [ck, cv] of Object.entries(value)) {
				if (typeof cv === "string" && cv.length > SPEECH_PASS_THROUGH_MAX) {
					const clipped = clipLines(cv);
					child[ck] = clipped.text;
					if (clipped.truncated) child[`${ck}TruncatedForSpeech`] = true;
				} else {
					child[ck] = cv;
				}
			}
			next[key] = child;
		} else {
			next[key] = value;
		}
	}
	return next;
}

/**
 * Returns the string that should become FunctionResponse.response.output.
 * Short plain strings pass through unchanged so progress/acks stay snappy.
 */
export function shapeRealtimeToolOutputForSpeech(toolName: string | undefined, outputText: string): string {
	if (typeof outputText !== "string") {
		return JSON.stringify({
			ok: true,
			summary: String(outputText),
			speechHint: DEFAULT_SPEECH_HINT,
		});
	}

	const trimmed = outputText.trim();
	if (!trimmed) {
		return JSON.stringify({ ok: true, summary: "Empty result.", speechHint: DEFAULT_SPEECH_HINT });
	}

	// Fast path: short non-JSON acknowledgements ("ok", "done", progress lines).
	const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
	if (!looksJson && trimmed.length <= SPEECH_PASS_THROUGH_MAX) {
		return outputText;
	}

	if (!looksJson) {
		const clipped = clipLines(outputText);
		return JSON.stringify({
			ok: true,
			summary: clipped.text,
			truncated: clipped.truncated,
			originalLength: clipped.originalLength,
			speechHint: DEFAULT_SPEECH_HINT,
		});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(outputText);
	} catch {
		const clipped = clipLines(outputText);
		return JSON.stringify({
			ok: true,
			summary: clipped.text,
			truncated: clipped.truncated,
			parseError: true,
			speechHint: DEFAULT_SPEECH_HINT,
		});
	}

	if (!isPlainObject(parsed)) {
		return JSON.stringify({
			ok: true,
			value: parsed,
			speechHint: DEFAULT_SPEECH_HINT,
		});
	}

	const name = (toolName || "").trim();
	let shaped: Record<string, unknown>;
	switch (name) {
		case "execute_terminal_command":
			shaped = shapeTerminal(parsed);
			break;
		case "read_workspace_file":
			shaped = shapeWorkspaceFile(parsed);
			break;
		case "get_agent_hub_agent":
			shaped = shapeAgentDetail(parsed);
			break;
		case "read_agent_transcript":
			shaped = shapeTranscriptDigest(parsed);
			break;
		case "summarize_hub":
			shaped = shapeHubBriefing(parsed);
			break;
		case "list_sessions":
		case "get_session_info":
		case "list_agent_hub_agents":
		case "browse_workspace":
		case "switch_session":
		case "launch_agent":
		case "archive_session":
			shaped = shapeSessionDashboard(parsed);
			break;
		default:
			shaped = shapeGenericObject(parsed);
			break;
	}

	if (typeof shaped.speechHint !== "string") {
		shaped.speechHint = DEFAULT_SPEECH_HINT;
	}
	return JSON.stringify(shaped);
}
