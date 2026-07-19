import { findNormalizedKey, getNumericRouteFamily } from "./voice-routing.js";

export type SessionRoutingState = {
	sessions: Record<string, string>;
	aliases: Record<string, string>;
};

export type SessionRuntimeSnapshot = {
	sessionPath?: string;
	sessionName?: string;
	workingDirectory?: string;
	cwd?: string;
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

export type SessionActivity = string;

export type SessionDashboardEntry = {
	name: string;
	path?: string;
	sessionPath?: string;
	provider?: string;
	sessionId?: string;
	resumable?: boolean;
	resumeCommand?: string[];
	workingDirectory?: string;
	cwd?: string;
	current: boolean;
	isCurrent: boolean;
	ready: boolean;
	isReady: boolean;
	activity: SessionActivity;
	aliases: string[];
	/** Basename of the working directory, for display grouping. */
	workspace?: string;
	/** Full working-directory path; stable grouping key (avoids basename collisions). */
	workspaceKey?: string;
	/** Last activity epoch ms (from runtime snapshot or session mtime). */
	lastActivity?: number;
	/** True when the session has been hidden/archived. */
	archived?: boolean;
	/** True when the session is stale (no use for >= STALE_SESSION_MS) and not current. */
	stale?: boolean;
};

export type WorkspaceGroup = {
	/** Display label (working-directory basename, or "(no workspace)"). */
	workspace: string;
	/** Full path grouping key. */
	workspaceKey: string;
	sessions: SessionDashboardEntry[];
};

export type SessionDashboard = {
	current: string;
	ready: string[];
	storePath?: string;
	sessions: SessionDashboardEntry[];
	/** Sessions grouped by workspace (working directory). */
	workspaces?: WorkspaceGroup[];
};

/** A session is stale after 24h without use. */
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

export function deriveWorkspaceKey(cwd: string | undefined): string | undefined {
	const trimmed = cwd?.trim();
	return trimmed ? trimmed.replace(/[\\/]+$/, "") : undefined;
}

export function deriveWorkspaceLabel(cwd: string | undefined): string {
	const key = deriveWorkspaceKey(cwd);
	if (!key) return "(no workspace)";
	const base = key.replace(/^.*[\\/]/, "");
	return base || key;
}

export function isSessionStale(lastActivity: number | undefined, now: number, isCurrent: boolean): boolean {
	if (isCurrent) return false;
	if (!lastActivity || !Number.isFinite(lastActivity)) return false;
	return now - lastActivity >= STALE_SESSION_MS;
}

export function groupSessionsByWorkspace(sessions: SessionDashboardEntry[]): WorkspaceGroup[] {
	const groups = new Map<string, WorkspaceGroup>();
	for (const entry of sessions) {
		const key = entry.workspaceKey ?? "(no workspace)";
		const label = entry.workspace ?? "(no workspace)";
		let group = groups.get(key);
		if (!group) {
			group = { workspace: label, workspaceKey: key, sessions: [] };
			groups.set(key, group);
		}
		group.sessions.push(entry);
	}
	return [...groups.values()].sort((a, b) => a.workspace.localeCompare(b.workspace));
}

export type BuildSessionDashboardOptions = {
	sessions: Record<string, string>;
	aliases: Record<string, string>;
	runtimeSnapshots?: SessionRuntimeSnapshot[];
	currentSessionPath?: string;
	currentSessionName?: string;
	currentBusy?: boolean;
	currentReady?: boolean;
	workingDirectories?: Record<string, string>;
	storePath?: string;
};

export function buildSessionDashboard(options: BuildSessionDashboardOptions): SessionDashboard {
	const snapshotByPath = new Map<string, SessionRuntimeSnapshot>();
	for (const snapshot of options.runtimeSnapshots || []) {
		if (!snapshot.sessionPath || snapshotByPath.has(snapshot.sessionPath)) continue;
		snapshotByPath.set(snapshot.sessionPath, snapshot);
	}

	const entries: SessionDashboardEntry[] = [];
	const seenPaths = new Set<string>();

	const addEntry = (name: string, sessionPath?: string) => {
		const snapshot = sessionPath ? snapshotByPath.get(sessionPath) : undefined;
		const aliases = dedupeSorted([
			...listAliasesForSession(sessionPath, options.aliases),
			...(snapshot?.aliases || []),
		]);
		const isCurrent = !!sessionPath && sessionPath === options.currentSessionPath;
		const activity: SessionActivity = isCurrent && typeof options.currentBusy === "boolean"
			? (options.currentBusy ? "busy" : "idle")
			: getSnapshotActivity(snapshot);
		const isReady = isCurrent && typeof options.currentReady === "boolean"
			? options.currentReady
			: !!snapshot?.waitingForAttention;
		const workingDirectory = sessionPath
			? options.workingDirectories?.[sessionPath] || snapshot?.workingDirectory || snapshot?.cwd
			: undefined;
		entries.push({
			name,
			path: sessionPath,
			sessionPath,
			workingDirectory,
			cwd: workingDirectory,
			workspace: deriveWorkspaceLabel(workingDirectory),
			workspaceKey: deriveWorkspaceKey(workingDirectory) ?? "(no workspace)",
			current: isCurrent,
			isCurrent,
			ready: isReady,
			isReady,
			activity,
			aliases,
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

	const sortedEntries = entries.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		if (a.isReady !== b.isReady) return a.isReady ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	const currentLabel = currentSessionName
		|| (currentSessionPath ? "(unnamed current session)" : "none");
	const readyNames = sortedEntries.filter((entry) => entry.isReady).map((entry) => entry.name);

	return {
		current: currentLabel,
		ready: readyNames,
		storePath: options.storePath,
		sessions: sortedEntries,
	};
}

export function buildSessionManagerEntries(options: BuildSessionDashboardOptions) {
	return buildSessionDashboard(options).sessions;
}

export type EnrichDashboardOptions = {
	now?: number;
	/** Full paths to treat as archived (hidden from the default view). */
	archivedPaths?: Iterable<string>;
};

// Post-processing applied to a merged dashboard (gateway side, where entries
// carry cwd + lastActivity): derives workspace grouping, marks stale entries
// (>24h, not current), hides archived paths, and attaches the `workspaces` view.
export function enrichDashboardWithWorkspaces(
	dashboard: SessionDashboard,
	options: EnrichDashboardOptions = {},
): SessionDashboard {
	const now = options.now ?? Date.now();
	const archived = new Set<string>();
	for (const path of options.archivedPaths ?? []) {
		const key = path?.trim();
		if (key) archived.add(key);
	}
	const visible: SessionDashboardEntry[] = [];
	for (const entry of dashboard.sessions) {
		const entryPath = entry.sessionPath ?? entry.path;
		const isArchived = !!entryPath && archived.has(entryPath);
		const cwd = entry.cwd ?? entry.workingDirectory;
		const enriched: SessionDashboardEntry = {
			...entry,
			workspace: entry.workspace ?? deriveWorkspaceLabel(cwd),
			workspaceKey: entry.workspaceKey ?? deriveWorkspaceKey(cwd) ?? "(no workspace)",
			archived: isArchived,
			stale: isSessionStale(entry.lastActivity, now, entry.isCurrent),
		};
		if (isArchived) continue; // track-and-hide
		visible.push(enriched);
	}
	return { ...dashboard, sessions: visible, workspaces: groupSessionsByWorkspace(visible) };
}

export type CompactRouteSlot = {
	family: "1" | "2";
	sessionName?: string;
	sessionPath?: string;
	labels: string[];
	status: "mapped" | "unassigned" | "ambiguous";
};

export function buildCompactRouteSlots(state: SessionRoutingState): CompactRouteSlot[] {
	const families: Array<"1" | "2"> = ["1", "2"];
	return families.map((family) => {
		const aliasEntries = Object.entries(state.aliases).filter(([alias]) => getNumericRouteFamily(alias) === family);
		const aliasPaths = [...new Set(aliasEntries.map(([, path]) => path))];
		if (aliasPaths.length > 1) {
			return {
				family,
				labels: aliasEntries.map(([alias]) => alias).sort((a, b) => a.localeCompare(b)),
				status: "ambiguous" as const,
			};
		}
		if (aliasPaths.length === 1) {
			return {
				family,
				sessionPath: aliasPaths[0],
				sessionName: findSessionNameByPath(aliasPaths[0], state.sessions) || "unknown",
				labels: aliasEntries.map(([alias]) => alias).sort((a, b) => a.localeCompare(b)),
				status: "mapped" as const,
			};
		}

		const sessionEntries = Object.entries(state.sessions).filter(([name]) => getNumericRouteFamily(name) === family);
		const sessionPaths = [...new Set(sessionEntries.map(([, path]) => path))];
		if (sessionPaths.length > 1) {
			return {
				family,
				labels: sessionEntries.map(([name]) => name).sort((a, b) => a.localeCompare(b)),
				status: "ambiguous" as const,
			};
		}
		if (sessionPaths.length === 1) {
			return {
				family,
				sessionPath: sessionPaths[0],
				sessionName: findSessionNameByPath(sessionPaths[0], state.sessions) || "unknown",
				labels: sessionEntries.map(([name]) => name).sort((a, b) => a.localeCompare(b)),
				status: "mapped" as const,
			};
		}
		return {
			family,
			labels: [],
			status: "unassigned" as const,
		};
	});
}

export function formatCompactRouteSlotSummary(state: SessionRoutingState) {
	return buildCompactRouteSlots(state)
		.map((slot) => `${slot.family} → ${slot.status === "mapped" ? slot.sessionName : slot.status === "ambiguous" ? "ambiguous" : "none"}`)
		.join(", ");
}

export function formatCompactRouteSlots(state: SessionRoutingState) {
	const lines = ["Compact routes"];
	for (const slot of buildCompactRouteSlots(state)) {
		if (slot.status === "mapped") {
			const labels = slot.labels.length > 0 ? ` via ${slot.labels.join(", ")}` : "";
			lines.push(`- ${slot.family}: ${slot.sessionName}${labels} (say \"PK ${slot.family === "1" ? "one\" or \"PK1" : "two\" or \"PK2"}\")`);
			continue;
		}
		if (slot.status === "ambiguous") {
			lines.push(`- ${slot.family}: ambiguous (${slot.labels.join(", ") || "multiple mappings"})`);
			continue;
		}
		lines.push(`- ${slot.family}: unassigned (use /sess wake ${slot.family === "1" ? "one" : "two"})`);
	}
	return lines.join("\n");
}

export function formatSessionManagerSummary(options: BuildSessionDashboardOptions) {
	const dashboard = buildSessionDashboard(options);
	const lines = [
		`Current: ${dashboard.current}`,
		`Ready: ${dashboard.ready.length > 0 ? dashboard.ready.join(", ") : "none"}`,
	];
	if (dashboard.storePath) lines.push(`Store: ${dashboard.storePath}`);
	lines.push(`Slots: ${formatCompactRouteSlotSummary({ sessions: options.sessions, aliases: options.aliases })}`);
	lines.push("Sessions");
	if (dashboard.sessions.length === 0) {
		lines.push("- none");
		return lines.join("\n");
	}
	for (const entry of dashboard.sessions) {
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
	lines.push('Tip: use /sess slots for PK one/PK1 and PK two/PK2 lane details.');
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
