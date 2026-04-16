import { findNormalizedKey } from "./voice-routing.js";

export type SessionRoutingState = {
	sessions: Record<string, string>;
	aliases: Record<string, string>;
};

export type SessionRuntimeSnapshot = {
	sessionPath?: string;
	sessionName?: string;
	phase?: string;
	waitingForAttention?: boolean;
	aliases?: string[];
};

export function findSessionRegistryKey(name: string, sessions: Record<string, string>) {
	return findNormalizedKey(name, Object.keys(sessions));
}

export function findWakeAliasKey(alias: string, aliases: Record<string, string>) {
	return findNormalizedKey(alias, Object.keys(aliases));
}

export function setNamedSession(sessions: Record<string, string>, name: string, sessionPath: string) {
	const existingName = findSessionRegistryKey(name, sessions);
	if (existingName && sessions[existingName] !== sessionPath) {
		return {
			ok: false as const,
			error: `Session name "${existingName}" already points to another session. Choose a different name.`,
		};
	}

	const next: Record<string, string> = {};
	for (const [key, value] of Object.entries(sessions)) {
		if (value === sessionPath) continue;
		if (existingName && key === existingName) continue;
		next[key] = value;
	}
	next[name] = sessionPath;
	return { ok: true as const, name, sessions: next };
}

export function setWakeAlias(aliases: Record<string, string>, alias: string, sessionPath: string) {
	const existingAlias = findWakeAliasKey(alias, aliases);
	const next = { ...aliases };
	if (existingAlias && existingAlias !== alias) {
		delete next[existingAlias];
	}
	next[alias] = sessionPath;
	return {
		alias,
		replacedAlias: existingAlias && existingAlias !== alias ? existingAlias : undefined,
		aliases: next,
	};
}

export function clearWakeAlias(aliases: Record<string, string>, alias: string) {
	const existingAlias = findWakeAliasKey(alias, aliases);
	if (!existingAlias) return { ok: false as const };
	const next = { ...aliases };
	delete next[existingAlias];
	return {
		ok: true as const,
		alias: existingAlias,
		aliases: next,
	};
}

export function removeSessionRoutingForPath(
	sessions: Record<string, string>,
	aliases: Record<string, string>,
	sessionPath: string,
) {
	const nextSessions: Record<string, string> = {};
	const nextAliases: Record<string, string> = {};
	const removedNames: string[] = [];
	const removedAliases: string[] = [];

	for (const [name, path] of Object.entries(sessions)) {
		if (path === sessionPath) {
			removedNames.push(name);
			continue;
		}
		nextSessions[name] = path;
	}

	for (const [alias, path] of Object.entries(aliases)) {
		if (path === sessionPath) {
			removedAliases.push(alias);
			continue;
		}
		nextAliases[alias] = path;
	}

	return {
		sessions: nextSessions,
		aliases: nextAliases,
		removedNames,
		removedAliases,
	};
}

export function findSessionNameByPath(sessionPath: string, sessions: Record<string, string>) {
	for (const [name, path] of Object.entries(sessions)) {
		if (path === sessionPath) return name;
	}
	return undefined;
}

export function listAliasesForSession(sessionPath: string | undefined, aliases: Record<string, string>) {
	if (!sessionPath) return [];
	return Object.entries(aliases)
		.filter(([, path]) => path === sessionPath)
		.map(([alias]) => alias)
		.sort((a, b) => a.localeCompare(b));
}

function dedupeSorted(values: string[]) {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getSnapshotActivity(snapshot: SessionRuntimeSnapshot | undefined) {
	if (!snapshot) return "saved";
	return snapshot.phase && snapshot.phase !== "ready" ? "busy" : "idle";
}

export function buildSessionManagerEntries(options: {
	sessions: Record<string, string>;
	aliases: Record<string, string>;
	runtimeSnapshots?: SessionRuntimeSnapshot[];
	currentSessionPath?: string;
	currentSessionName?: string;
	currentBusy?: boolean;
	currentReady?: boolean;
}) {
	const snapshotByPath = new Map<string, SessionRuntimeSnapshot>();
	for (const snapshot of options.runtimeSnapshots || []) {
		if (!snapshot.sessionPath || snapshotByPath.has(snapshot.sessionPath)) continue;
		snapshotByPath.set(snapshot.sessionPath, snapshot);
	}

	const entries: Array<{
		name: string;
		sessionPath?: string;
		aliases: string[];
		isCurrent: boolean;
		isReady: boolean;
		activity: "busy" | "idle" | "saved";
	}> = [];
	const seenPaths = new Set<string>();

	const addEntry = (name: string, sessionPath?: string) => {
		const snapshot = sessionPath ? snapshotByPath.get(sessionPath) : undefined;
		const aliases = dedupeSorted([
			...listAliasesForSession(sessionPath, options.aliases),
			...(snapshot?.aliases || []),
		]);
		const isCurrent = !!sessionPath && sessionPath === options.currentSessionPath;
		const activity = isCurrent && typeof options.currentBusy === "boolean"
			? (options.currentBusy ? "busy" : "idle")
			: getSnapshotActivity(snapshot);
		const isReady = isCurrent && typeof options.currentReady === "boolean"
			? options.currentReady
			: !!snapshot?.waitingForAttention;
		entries.push({
			name,
			sessionPath,
			aliases,
			isCurrent,
			isReady,
			activity,
		});
		if (sessionPath) seenPaths.add(sessionPath);
	};

	for (const [name, sessionPath] of Object.entries(options.sessions)) {
		addEntry(name, sessionPath);
	}

	const currentSessionPath = options.currentSessionPath;
	const currentSessionName = options.currentSessionName?.trim();
	if (currentSessionPath && !seenPaths.has(currentSessionPath)) {
		addEntry(currentSessionName || "(unnamed current session)", currentSessionPath);
	}

	return entries.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		if (a.isReady !== b.isReady) return a.isReady ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

export function formatSessionManagerSummary(options: {
	sessions: Record<string, string>;
	aliases: Record<string, string>;
	runtimeSnapshots?: SessionRuntimeSnapshot[];
	currentSessionPath?: string;
	currentSessionName?: string;
	currentBusy?: boolean;
	currentReady?: boolean;
	storePath?: string;
}) {
	const entries = buildSessionManagerEntries(options);
	const currentLabel = options.currentSessionName?.trim()
		|| (options.currentSessionPath ? "(unnamed current session)" : "none");
	const readyNames = entries.filter((entry) => entry.isReady).map((entry) => entry.name);
	const lines = [
		`Current: ${currentLabel}`,
		`Ready: ${readyNames.length > 0 ? readyNames.join(", ") : "none"}`,
	];
	if (options.storePath) lines.push(`Store: ${options.storePath}`);
	lines.push("Sessions");
	if (entries.length === 0) {
		lines.push("- none");
		return lines.join("\n");
	}
	for (const entry of entries) {
		const tags = [
			...(entry.isCurrent ? ["current"] : []),
			...(entry.isReady ? ["ready"] : []),
			entry.activity,
		];
		lines.push(`- ${entry.name} [${tags.join("] [")}]`);
		if (entry.aliases.length > 0) {
			lines.push(`  aliases: ${entry.aliases.join(", ")}`);
		}
	}
	return lines.join("\n");
}

export function formatSessionRoutingList(state: SessionRoutingState) {
	const names = Object.keys(state.sessions).join(", ");
	const aliasSummary = Object.entries(state.aliases)
		.map(([alias, sessionPath]) => `${alias} → ${findSessionNameByPath(sessionPath, state.sessions) || "unknown"}`)
		.join(", ");
	return [
		names ? `Sessions: ${names}` : "Sessions: none",
		aliasSummary ? `Wake aliases: ${aliasSummary}` : "Wake aliases: none",
	].join(". ");
}

export function describeSessionRoutingStore(path: string, state: SessionRoutingState) {
	return `${formatSessionRoutingList(state)}. Store: ${path}`;
}
