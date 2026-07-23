import { resolve, sep } from "node:path";
import type { AttentionLeaderLease, AttentionSessionSnapshot } from "./attention-broker.js";
import type { HubAgent } from "./herdr-agent-hub-schema.js";
import type { SessionDashboard, SessionDashboardEntry } from "./session-routing.js";

export type RealtimeSessionTargetSource = "dashboard" | "attention" | "hub";

export type RealtimeSessionTargetCandidate = {
	/** Stable display identity; additional names are retained in `names`. */
	name?: string;
	names: string[];
	aliases: string[];
	agentId?: string;
	sessionId?: string;
	sessionPath?: string;
	provider?: string;
	cwd?: string;
	/** Epoch ms of last observed activity; drives recency-first ordering for the assistant. */
	lastActivity?: number;
	isCurrent: boolean;
	sources: RealtimeSessionTargetSource[];
};

export type RealtimeSessionTargetSources = {
	dashboard?: Pick<SessionDashboard, "sessions"> | readonly SessionDashboardEntry[];
	attentionSnapshots?: readonly AttentionSessionSnapshot[];
	hubAgents?: readonly HubAgent[];
};

export type RealtimeSessionTargetRef = {
	agentId?: string;
	sessionId?: string;
	sessionPath?: string;
	name?: string;
};

export type RealtimeSessionTargetResolution =
	| {
			ok: true;
			candidate: RealtimeSessionTargetCandidate;
			match: "agent-id" | "session-id" | "path" | "name" | "alias" | "fragment" | "selected-connection" | "dashboard-current" | "lease";
		}
	| {
			ok: false;
			reason: "missing-target" | "not-found" | "ambiguous";
			candidates?: RealtimeSessionTargetCandidate[];
		};

function key(value: string | undefined): string {
	return value?.trim().toLowerCase() || "";
}

export function canonicalRealtimeSessionPath(path: string | undefined): string {
	if (!path?.trim()) return "";
	const resolved = resolve(path.trim());
	return sep === "\\" ? resolved.toLowerCase() : resolved;
}

function sourceEntries(sources: RealtimeSessionTargetSources): {
	dashboard: readonly SessionDashboardEntry[];
	attentionSnapshots: readonly AttentionSessionSnapshot[];
	hubAgents: readonly HubAgent[];
} {
	const rawDashboard = sources.dashboard;
	return {
		dashboard: rawDashboard && "sessions" in rawDashboard ? rawDashboard.sessions : rawDashboard ?? [],
		attentionSnapshots: sources.attentionSnapshots ?? [],
		hubAgents: sources.hubAgents ?? [],
	};
}

function newCandidate(
	partial: Omit<RealtimeSessionTargetCandidate, "names" | "aliases" | "sources" | "isCurrent"> & {
		names?: string[];
		aliases?: string[];
		source: RealtimeSessionTargetSource;
		isCurrent?: boolean;
	},
): RealtimeSessionTargetCandidate {
	const names = [...new Set([partial.name, ...(partial.names ?? [])].filter((value): value is string => !!value?.trim()))];
	return {
		name: names[0],
		names,
		aliases: [...new Set((partial.aliases ?? []).filter((value) => !!value?.trim()))],
		agentId: partial.agentId?.trim() || undefined,
		sessionId: partial.sessionId?.trim() || undefined,
		sessionPath: partial.sessionPath?.trim() || undefined,
		provider: partial.provider?.trim() || undefined,
		cwd: partial.cwd?.trim() || undefined,
		lastActivity: partial.lastActivity,
		isCurrent: partial.isCurrent === true,
		sources: [partial.source],
	};
}

function sameCandidate(left: RealtimeSessionTargetCandidate, right: RealtimeSessionTargetCandidate): boolean {
	if (left.sessionId && right.sessionId && key(left.sessionId) === key(right.sessionId)) return true;
	if (left.sessionPath && right.sessionPath && canonicalRealtimeSessionPath(left.sessionPath) === canonicalRealtimeSessionPath(right.sessionPath)) return true;
	if (left.agentId && right.agentId && key(left.agentId) === key(right.agentId)) return true;
	return false;
}

function mergeCandidate(target: RealtimeSessionTargetCandidate, incoming: RealtimeSessionTargetCandidate): void {
	target.names = [...new Set([...target.names, ...incoming.names])];
	target.aliases = [...new Set([...target.aliases, ...incoming.aliases])];
	target.agentId ||= incoming.agentId;
	target.sessionId ||= incoming.sessionId;
	target.sessionPath ||= incoming.sessionPath;
	target.provider ||= incoming.provider;
	target.cwd ||= incoming.cwd;
	if (incoming.lastActivity !== undefined && (target.lastActivity === undefined || incoming.lastActivity > target.lastActivity)) {
		target.lastActivity = incoming.lastActivity;
	}
	target.isCurrent ||= incoming.isCurrent;
	for (const source of incoming.sources) if (!target.sources.includes(source)) target.sources.push(source);
	if (!target.name) target.name = incoming.name;
}

export function buildRealtimeSessionCandidates(sources: RealtimeSessionTargetSources = {}): RealtimeSessionTargetCandidate[] {
	const entries = sourceEntries(sources);
	const candidates: RealtimeSessionTargetCandidate[] = [];
	const add = (candidate: RealtimeSessionTargetCandidate) => {
		const existing = candidates.find((entry) => sameCandidate(entry, candidate));
		if (existing) mergeCandidate(existing, candidate);
		else candidates.push(candidate);
	};

	for (const entry of entries.dashboard) {
		add(newCandidate({
			name: entry.name,
			names: [entry.name],
			aliases: entry.aliases,
			sessionId: entry.sessionId,
			sessionPath: entry.sessionPath ?? entry.path,
			provider: entry.provider,
			cwd: entry.cwd ?? entry.workingDirectory,
			lastActivity: typeof entry.lastActivity === "number" ? entry.lastActivity : undefined,
			source: "dashboard",
			isCurrent: entry.isCurrent,
		}));
	}
	for (const snapshot of entries.attentionSnapshots) {
		add(newCandidate({
			name: snapshot.sessionName,
			names: snapshot.sessionName ? [snapshot.sessionName] : [],
			aliases: snapshot.aliases,
			sessionId: snapshot.sessionId,
			sessionPath: snapshot.sessionPath,
			isCurrent: false,
			source: "attention",
		}));
	}
	for (const agent of entries.hubAgents) {
		add(newCandidate({
			name: agent.displayName,
			names: [agent.displayName],
			agentId: agent.id,
			sessionPath: agent.sessionFile ?? undefined,
			cwd: agent.cwd ?? undefined,
			source: "hub",
			isCurrent: false,
		}));
	}
	// Recent sessions surface first so the assistant naturally weighs recency
	// ("recent = higher visibility"); the current session always leads.
	return candidates.sort((left, right) => {
		if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
		return (right.lastActivity ?? 0) - (left.lastActivity ?? 0);
	});
}

function candidateValues(candidate: RealtimeSessionTargetCandidate, field: "agentId" | "sessionId" | "path" | "name" | "alias"): string[] {
	switch (field) {
		case "agentId": return candidate.agentId ? [key(candidate.agentId)] : [];
		case "sessionId": return candidate.sessionId ? [key(candidate.sessionId)] : [];
		case "path": return candidate.sessionPath ? [canonicalRealtimeSessionPath(candidate.sessionPath)] : [];
		case "name": return candidate.names.map(key);
		case "alias": return candidate.aliases.map(key);
	}
}

function exactMatches(target: string, candidates: RealtimeSessionTargetCandidate[], field: Parameters<typeof candidateValues>[1]): RealtimeSessionTargetCandidate[] {
	const wanted = field === "path" ? canonicalRealtimeSessionPath(target) : key(target);
	return candidates.filter((candidate) => candidateValues(candidate, field).includes(wanted));
}

type RealtimeSessionExactMatch = "agent-id" | "session-id" | "path" | "name" | "alias";

function resultForMatches(matches: RealtimeSessionTargetCandidate[], match: RealtimeSessionExactMatch | "fragment"): RealtimeSessionTargetResolution {
	if (matches.length === 1) return { ok: true, candidate: matches[0], match };
	if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches };
	return { ok: false, reason: "not-found" };
}

export function resolveRealtimeSessionTarget(target: string | undefined, sources: RealtimeSessionTargetSources = {}): RealtimeSessionTargetResolution {
	const trimmed = target?.trim();
	if (!trimmed) return { ok: false, reason: "missing-target" };
	const candidates = buildRealtimeSessionCandidates(sources);
	const fields: Array<[Parameters<typeof candidateValues>[1], RealtimeSessionExactMatch]> = [
		["agentId", "agent-id"],
		["sessionId", "session-id"],
		["path", "path"],
		["name", "name"],
		["alias", "alias"],
	];
	for (const [field, match] of fields) {
		const result = resultForMatches(exactMatches(trimmed, candidates, field), match);
		if (result.ok || result.reason === "ambiguous") return result;
	}
	const fragment = key(trimmed);
	const fragmentMatches = candidates.filter((candidate) => [
		...candidateValues(candidate, "agentId"),
		...candidateValues(candidate, "sessionId"),
		...candidateValues(candidate, "path"),
		...candidateValues(candidate, "name"),
		...candidateValues(candidate, "alias"),
	].some((value) => value.includes(fragment)));
	return resultForMatches(fragmentMatches, "fragment");
}

function exactRefMatches(ref: RealtimeSessionTargetRef, candidates: RealtimeSessionTargetCandidate[]): RealtimeSessionTargetCandidate[] {
	const fields: Array<[keyof RealtimeSessionTargetRef, Parameters<typeof candidateValues>[1]]> = [
		["agentId", "agentId"],
		["sessionId", "sessionId"],
		["sessionPath", "path"],
		["name", "name"],
	];
	for (const [refField, candidateField] of fields) {
		const value = ref[refField];
		if (!value?.trim()) continue;
		const matches = exactMatches(value, candidates, candidateField);
		if (matches.length > 0) return matches;
	}
	return [];
}

export type RealtimeCurrentTargetOptions = RealtimeSessionTargetSources & {
	selectedConnection?: RealtimeSessionTargetRef;
	attentionLeader?: AttentionLeaderLease;
};

export function selectRealtimeCurrentTarget(options: RealtimeCurrentTargetOptions = {}): RealtimeSessionTargetResolution {
	const candidates = buildRealtimeSessionCandidates(options);
	if (options.selectedConnection) {
		const matches = exactRefMatches(options.selectedConnection, candidates);
		if (matches.length === 1) return { ok: true, candidate: matches[0], match: "selected-connection" };
		if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches };
		return { ok: false, reason: "not-found" };
	}
	const current = candidates.filter((candidate) => candidate.isCurrent);
	if (current.length === 1) return { ok: true, candidate: current[0], match: "dashboard-current" };
	if (current.length > 1) return { ok: false, reason: "ambiguous", candidates: current };
	const ownerId = options.attentionLeader?.ownerSessionId;
	if (ownerId) {
		const leaseMatches = candidates.filter((candidate) => candidate.sessionId && key(candidate.sessionId) === key(ownerId));
		if (leaseMatches.length === 1) return { ok: true, candidate: leaseMatches[0], match: "lease" };
		if (leaseMatches.length > 1) return { ok: false, reason: "ambiguous", candidates: leaseMatches };
	}
	return { ok: false, reason: "not-found" };
}
