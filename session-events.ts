import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSessionRoutingStorePath } from "./session-routing-store.js";

export type SessionEventSource = "voice" | "command" | "admin";

export type SessionEventPayload = Record<string, unknown>;

export type SessionEvent = {
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
	const event: SessionEvent = {
		ts: Date.now(),
		kind,
		source,
		payload,
	};
	const path = getSessionEventsPath();
	const lines = readAllLines(path);
	lines.push(JSON.stringify(event));
	const trimmed = lines.length > MAX_EVENT_LINES ? lines.slice(lines.length - MAX_EVENT_LINES) : lines;
	writeFileSync(path, `${trimmed.join("\n")}\n`, "utf8");
	return event;
}

export function tailSessionEvents(sinceOffset = 0): TailSessionEventsResult {
	const path = getSessionEventsPath();
	const lines = readAllLines(path);
	const start = sinceOffset < 0 || sinceOffset > lines.length ? 0 : sinceOffset;
	const events: SessionEvent[] = [];
	for (let i = start; i < lines.length; i++) {
		const event = parseEventLine(lines[i]);
		if (event) events.push(event);
	}
	return { events, nextOffset: lines.length };
}
