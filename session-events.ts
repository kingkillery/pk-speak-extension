import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSessionRoutingStorePath } from "./session-routing-store.js";

export type SessionEventSource = "voice" | "command" | "admin";

export type SessionEventPayload = Record<string, unknown>;

export type SessionEvent = {
	/**
	 * Monotonic sequence number, stable across the MAX_EVENT_LINES rollover. The
	 * tail cursor (`nextOffset`) is the highest seq seen, NOT a line index — a line
	 * index desynced silently once the log trimmed, permanently starving pollers.
	 */
	seq: number;
	ts: number;
	kind: string;
	source: SessionEventSource;
	payload: SessionEventPayload;
};

export type TailSessionEventsResult = {
	events: SessionEvent[];
	nextOffset: number;
};

const MAX_EVENT_LINES = 200;

export function getSessionEventsPath() {
	return join(dirname(getSessionRoutingStorePath()), "session-events.jsonl");
}

function ensureEventsDir() {
	mkdirSync(dirname(getSessionEventsPath()), { recursive: true });
}

function readAllLines(path: string): string[] {
	if (!existsSync(path)) return [];
	const contents = readFileSync(path, "utf8");
	if (!contents) return [];
	return contents.split(/\r?\n/).filter((line) => line.length > 0);
}

function parseEventLine(line: string): SessionEvent | undefined {
	try {
		const parsed = JSON.parse(line) as Partial<SessionEvent> | null;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (typeof parsed.kind !== "string") return undefined;
		const source: SessionEventSource =
			parsed.source === "voice" || parsed.source === "command" || parsed.source === "admin"
				? parsed.source
				: "command";
		const payload =
			parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
				? (parsed.payload as SessionEventPayload)
				: {};
		return {
			seq: typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : 0,
			ts: typeof parsed.ts === "number" ? parsed.ts : 0,
			kind: parsed.kind,
			source,
			payload,
		};
	} catch {
		return undefined;
	}
}

export function appendSessionEvent(
	kind: string,
	source: SessionEventSource,
	payload: SessionEventPayload = {},
): SessionEvent {
	ensureEventsDir();
	const path = getSessionEventsPath();
	const lines = readAllLines(path);
	// Next seq = (highest existing seq) + 1, so it keeps climbing across the
	// MAX_EVENT_LINES trim. Legacy lines without seq parse as 0.
	let maxSeq = 0;
	for (const line of lines) {
		const existing = parseEventLine(line);
		if (existing && existing.seq > maxSeq) maxSeq = existing.seq;
	}
	const event: SessionEvent = {
		seq: maxSeq + 1,
		ts: Date.now(),
		kind,
		source,
		payload,
	};
	lines.push(JSON.stringify(event));
	const trimmed = lines.length > MAX_EVENT_LINES ? lines.slice(lines.length - MAX_EVENT_LINES) : lines;
	writeFileSync(path, `${trimmed.join("\n")}\n`, "utf8");
	return event;
}

// `sinceSeq` is the last seq the caller already saw (the prior `nextOffset`).
// Returns events strictly newer than it, plus the new high-water seq. This is
// trim-stable: appends keep incrementing seq even as old lines roll off, so a
// poller never silently stops receiving events after MAX_EVENT_LINES (the old
// line-index cursor did). The parameter name stays `sinceOffset` for callers,
// but it is now an opaque monotonic cursor, not a line index.
export function tailSessionEvents(sinceOffset = 0): TailSessionEventsResult {
	const path = getSessionEventsPath();
	const lines = readAllLines(path);
	const sinceSeq = sinceOffset < 0 ? 0 : sinceOffset;
	const events: SessionEvent[] = [];
	let maxSeq = sinceSeq;
	for (const line of lines) {
		const event = parseEventLine(line);
		if (!event) continue;
		if (event.seq > maxSeq) maxSeq = event.seq;
		if (event.seq > sinceSeq) events.push(event);
	}
	return { events, nextOffset: maxSeq };
}
