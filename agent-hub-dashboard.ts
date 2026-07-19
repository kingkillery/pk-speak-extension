import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent, type Stats } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { SessionDashboard, SessionDashboardEntry } from "./session-routing.js";

const JSONL_SUFFIX = ".jsonl";
const ADVISOR_TRANSCRIPT_FILENAME = "__advisor.jsonl";

type BackgroundInstance = { name: string; status: "active"; model?: string; role?: string };
type SessionHeader = {
	id: string;
	cwd?: string;
	timestamp?: string;
	backgroundInstance?: unknown;
	hasBackgroundInstance: boolean;
};

export type OhMyPiAgentHubSubagent = {
	id: string;
	name: string;
	status: "parked";
	sessionPath: string;
	activity: "background subagent";
	createdAt: number;
	lastActivity: number;
};

export type OhMyPiBackgroundSessionEntry = SessionDashboardEntry & {
	path: string;
	sessionPath: string;
	provider: "oh-my-pk";
	resumable: true;
	resumeCommand: string[];
	kind: "background";
	source: "oh-my-pk";
	model?: string;
	role?: string;
	createdAt?: number;
	lastActivity?: number;
	subagents: OhMyPiAgentHubSubagent[];
};

export type OhMyPiAgentHubDashboard = Omit<SessionDashboard, "sessions"> & {
	sessions: OhMyPiBackgroundSessionEntry[];
	scannedRoots: string[];
	source: "oh-my-pk";
	generatedAt: number;
};

export type BuildOhMyPiAgentHubDashboardOptions = {
	sessionsRoots?: string[];
	env?: NodeJS.ProcessEnv;
	now?: () => number;
};

export function defaultOhMyPiSessionRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const configuredRoots = [
		...splitConfiguredRoots(env.PI_SPEAK_OH_MY_PK_SESSIONS_ROOT),
		...splitConfiguredRoots(env.PI_SPEAK_OH_MY_PI_SESSIONS_ROOT),
		...splitConfiguredRoots(env.PI_SPEAK_AGENT_HUB_SESSIONS_ROOT),
	];
	const agentDirs = [
		env.PI_CODING_AGENT_DIR?.trim(),
		env.PI_SPEAK_OH_MY_PK_AGENT_DIR?.trim(),
		env.PI_SPEAK_OH_MY_PI_AGENT_DIR?.trim(),
	]
		.filter((value): value is string => !!value);
	return dedupeStrings([
		...configuredRoots,
		...agentDirs.map((dir) => join(dir, "sessions")),
		join(homedir(), ".ompk", "agent", "sessions"),
		join(homedir(), ".omp", "agent", "sessions"),
	]);
}

export function buildOhMyPiAgentHubDashboard(
	options: BuildOhMyPiAgentHubDashboardOptions = {},
): OhMyPiAgentHubDashboard {
	const now = options.now ?? Date.now;
	const roots = options.sessionsRoots ?? defaultOhMyPiSessionRoots(options.env);
	const scannedRoots = roots.filter((root) => existsSync(root));
	const sessions = scannedRoots
		.flatMap((root) => listSessionFiles(root).map(parseBackgroundSessionFile))
		.filter((entry): entry is OhMyPiBackgroundSessionEntry => entry !== undefined)
		.sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
	return {
		current: "oh-my-pk",
		ready: [],
		storePath: roots.length === 1 ? roots[0] : roots.join(delimiter),
		sessions,
		scannedRoots,
		source: "oh-my-pk",
		generatedAt: now(),
	};
}

let cachedAgentHub: { at: number; dashboard: OhMyPiAgentHubDashboard } | undefined;
let agentHubRefreshInFlight = false;
const DEFAULT_AGENT_HUB_TTL_MS = 2000;

function refreshAgentHubDashboard(): OhMyPiAgentHubDashboard {
	const dashboard = buildOhMyPiAgentHubDashboard();
	cachedAgentHub = { at: Date.now(), dashboard };
	return dashboard;
}

function scheduleAgentHubRefresh(): void {
	if (agentHubRefreshInFlight) return;
	agentHubRefreshInFlight = true;
	setImmediate(() => {
		try {
			refreshAgentHubDashboard();
		} catch {
			// Keep the previous snapshot on refresh failure.
		} finally {
			agentHubRefreshInFlight = false;
		}
	});
}

// Serve-stale-while-revalidate so the bounded-but-still-disk-bound omp scan never
// blocks the dashboard request after the first warm-up.
export function buildOhMyPiAgentHubDashboardCached(ttlMs = DEFAULT_AGENT_HUB_TTL_MS): OhMyPiAgentHubDashboard {
	const now = Date.now();
	if (ttlMs <= 0) return refreshAgentHubDashboard();
	if (cachedAgentHub) {
		if (now - cachedAgentHub.at >= ttlMs) scheduleAgentHubRefresh();
		return cachedAgentHub.dashboard;
	}
	return refreshAgentHubDashboard();
}

export function mergeOhMyPiAgentHubSessions(
	dashboard: SessionDashboard,
	options: BuildOhMyPiAgentHubDashboardOptions = {},
): SessionDashboard {
	const agentHub = buildOhMyPiAgentHubDashboard(options);
	const existingPaths = new Set(
		dashboard.sessions.map((entry) => entry.sessionPath ?? entry.path).filter((path): path is string => !!path),
	);
	const additions = agentHub.sessions.filter((entry) => !existingPaths.has(entry.sessionPath));
	return additions.length === 0 ? dashboard : { ...dashboard, sessions: [...dashboard.sessions, ...additions] };
}

// Hot-path merge used by the gateway dashboard: reuses the stale-while-revalidate
// cached omp scan instead of re-scanning disk on every request.
export function mergeOhMyPiAgentHubSessionsCached(
	dashboard: SessionDashboard,
	ttlMs = DEFAULT_AGENT_HUB_TTL_MS,
): SessionDashboard {
	const agentHub = buildOhMyPiAgentHubDashboardCached(ttlMs);
	const existingPaths = new Set(
		dashboard.sessions.map((entry) => entry.sessionPath ?? entry.path).filter((path): path is string => !!path),
	);
	const additions = agentHub.sessions.filter((entry) => !existingPaths.has(entry.sessionPath));
	return additions.length === 0 ? dashboard : { ...dashboard, sessions: [...dashboard.sessions, ...additions] };
}

function splitConfiguredRoots(value: string | undefined): string[] {
	return value ? value.split(delimiter).map((part) => part.trim()).filter((part) => part.length > 0) : [];
}

function dedupeStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function listSessionFiles(root: string): string[] {
	const sessionFiles: string[] = [];
	for (const entry of safeReadDir(root)) {
		const entryPath = join(root, entry.name);
		if (entry.isFile() && isSessionJsonl(entry.name)) {
			sessionFiles.push(entryPath);
		} else if (entry.isDirectory()) {
			for (const child of safeReadDir(entryPath)) {
				if (child.isFile() && isSessionJsonl(child.name)) sessionFiles.push(join(entryPath, child.name));
			}
		}
	}
	return sessionFiles;
}

const SESSION_HEADER_READ_BYTES = 256 * 1024;
const BACKGROUND_INSTANCE_TAIL_BYTES = 256 * 1024;

function parseBackgroundSessionFile(sessionPath: string): OhMyPiBackgroundSessionEntry | undefined {
	const stat = safeStat(sessionPath);
	if (!stat) return undefined;

	// The session header is record 0. Read only a bounded prefix so the 184 of
	// ~195 transcripts that are NOT background lanes are rejected after a small
	// read instead of slurping 261 MB of jsonl on every dashboard scan.
	const headerPrefix = readFilePrefixBytes(sessionPath, SESSION_HEADER_READ_BYTES);
	if (headerPrefix === undefined) return undefined;
	const header = readSessionHeader(parseJsonLineRecords(headerPrefix));
	if (!header) return undefined;

	let backgroundInstance: BackgroundInstance | undefined;
	if (header.hasBackgroundInstance) {
		backgroundInstance = normalizeBackgroundInstance(header.backgroundInstance);
	} else {
		// Older sessions append the background_instance record near the end; scan a
		// bounded tail rather than the whole file.
		const tail = readFileTailBytes(sessionPath, stat.size, BACKGROUND_INSTANCE_TAIL_BYTES);
		if (tail !== undefined) {
			const tailRecords = parseJsonLineRecords(tail);
			for (let index = tailRecords.length - 1; index >= 0; index -= 1) {
				if (tailRecords[index].type === "background_instance") {
					backgroundInstance = normalizeBackgroundInstance(tailRecords[index]);
					break;
				}
			}
		}
	}
	if (!backgroundInstance) return undefined;

	const createdAt = parseTimestamp(header.timestamp) ?? fallbackCreatedAt(stat);
	const lastActivity = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.now();
	const activity = backgroundInstance.model
		? `background session - ${backgroundInstance.model}`
		: "background session";
	return {
		name: backgroundInstance.name,
		path: sessionPath,
		sessionPath,
		provider: "oh-my-pk",
		sessionId: header.id,
		resumable: true,
		resumeCommand: ["ompk", "--resume", header.id],
		workingDirectory: header.cwd,
		cwd: header.cwd,
		current: false,
		isCurrent: false,
		ready: false,
		isReady: false,
		activity,
		aliases: [],
		kind: "background",
		source: "oh-my-pk",
		model: backgroundInstance.model,
		role: backgroundInstance.role,
		createdAt,
		lastActivity,
		subagents: collectBackgroundSubagents(sessionPath, `background:${header.id}`),
	};
}

function parseJsonLineRecords(content: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			if (error instanceof SyntaxError) continue;
			throw error;
		}
		if (isRecord(parsed)) records.push(parsed);
	}
	return records;
}

function readSessionHeader(records: Record<string, unknown>[]): SessionHeader | undefined {
	const first = records[0];
	if (!first || first.type !== "session" || typeof first.id !== "string") return undefined;
	return {
		id: first.id,
		cwd: typeof first.cwd === "string" ? first.cwd : undefined,
		timestamp: typeof first.timestamp === "string" ? first.timestamp : undefined,
		backgroundInstance: first.backgroundInstance,
		hasBackgroundInstance: Object.prototype.hasOwnProperty.call(first, "backgroundInstance"),
	};
}

function normalizeBackgroundInstance(value: unknown): BackgroundInstance | undefined {
	if (!isRecord(value) || value.status !== "active" || typeof value.name !== "string") return undefined;
	return {
		name: value.name,
		status: "active",
		model: typeof value.model === "string" ? value.model : undefined,
		role: typeof value.role === "string" ? value.role : undefined,
	};
}

function collectBackgroundSubagents(sessionPath: string, laneId: string): OhMyPiAgentHubSubagent[] {
	const artifactsDir = sessionPath.slice(0, -JSONL_SUFFIX.length);
	const subagents: OhMyPiAgentHubSubagent[] = [];
	for (const entry of safeReadDir(artifactsDir)) {
		if (!entry.isFile() || !isSessionJsonl(entry.name) || entry.name === ADVISOR_TRANSCRIPT_FILENAME) continue;
		const name = entry.name.slice(0, -JSONL_SUFFIX.length);
		const subagentPath = join(artifactsDir, entry.name);
		const stat = safeStat(subagentPath);
		const lastActivity = stat?.mtimeMs && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.now();
		subagents.push({
			id: `${laneId}/${name}`,
			name,
			status: "parked",
			sessionPath: subagentPath,
			activity: "background subagent",
			createdAt: lastActivity,
			lastActivity,
		});
	}
	return subagents.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Finds the session file currently owning a given background-lane name, regardless of whether
 * the lane is active or archived. buildOhMyPiAgentHubDashboard only surfaces ACTIVE lanes (an
 * archived lane's name is intentionally invisible to that scan), so a revive/recover flow that
 * needs to resolve an id back to a file after archiving uses this instead.
 */
export function findOhMyPiBackgroundSessionPath(
	name: string,
	options: BuildOhMyPiAgentHubDashboardOptions = {},
): string | undefined {
	const roots = (options.sessionsRoots ?? defaultOhMyPiSessionRoots(options.env)).filter((root) => existsSync(root));
	for (const root of roots) {
		for (const sessionPath of listSessionFiles(root)) {
			const stat = safeStat(sessionPath);
			if (!stat) continue;
			const headerPrefix = readFilePrefixBytes(sessionPath, SESSION_HEADER_READ_BYTES);
			if (headerPrefix === undefined) continue;
			const header = readSessionHeader(parseJsonLineRecords(headerPrefix));
			if (!header) continue;
			let candidateName = header.hasBackgroundInstance ? backgroundInstanceName(header.backgroundInstance) : undefined;
			if (candidateName === undefined) {
				const tail = readFileTailBytes(sessionPath, stat.size, BACKGROUND_INSTANCE_TAIL_BYTES);
				if (tail !== undefined) {
					const tailRecords = parseJsonLineRecords(tail);
					for (let index = tailRecords.length - 1; index >= 0; index -= 1) {
						if (tailRecords[index].type === "background_instance") {
							candidateName = backgroundInstanceName(tailRecords[index]);
							break;
						}
					}
				}
			}
			if (candidateName === name) return sessionPath;
		}
	}
	return undefined;
}

function backgroundInstanceName(value: unknown): string | undefined {
	return isRecord(value) && typeof value.name === "string" ? value.name : undefined;
}

function isSessionJsonl(name: string): boolean {
	return name.endsWith(JSONL_SUFFIX) && !name.includes(".bak");
}

function safeReadDir(path: string): Dirent[] {
	return tryOrUndefined(() => readdirSync(path, { withFileTypes: true })) ?? [];
}

function safeStat(path: string): Stats | undefined {
	return tryOrUndefined(() => statSync(path));
}

function readFilePrefixBytes(path: string, maxBytes: number): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(maxBytes);
		const bytes = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytes).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
	}
}

function readFileTailBytes(path: string, size: number, maxBytes: number): string | undefined {
	const start = Math.max(0, size - maxBytes);
	const length = size - start;
	if (length <= 0) return "";
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(length);
		const bytes = readSync(fd, buffer, 0, length, start);
		return buffer.subarray(0, bytes).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
	}
}

function tryOrUndefined<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch (error) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}

function parseTimestamp(value: string | undefined): number | undefined {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function fallbackCreatedAt(stat: Stats): number {
	return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs > 0 ? stat.ctimeMs : stat.mtimeMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
