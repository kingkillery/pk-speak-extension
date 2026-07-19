import {
	clearWakeAlias,
	listAliasesForSession,
	removeSessionRoutingForPath,
	setNamedSession,
	setWakeAlias,
	findSessionNameByPath,
} from "../session-routing.js";
import {
	loadPersistedSessionRouting,
	persistSessionRouting,
} from "../session-routing-store.js";
import { appendSessionEvent } from "../session-events.js";

export const REMOVE_CONFIRM_TTL_MS = 15_000;

export type ActionResult<T extends object = Record<string, never>> =
	| ({ ok: true } & T)
	| { ok: false; error: string };

export type RenameSessionInput = {
	sessionPath: string;
	newName: string;
};

export type RenameSessionSuccess = {
	from: string;
	to: string;
	sessionPath: string;
};

export function renameSession(input: RenameSessionInput): ActionResult<RenameSessionSuccess> {
	const nextName = input.newName.trim();
	if (!nextName) return { ok: false, error: "New name is required." };
	if (!input.sessionPath) return { ok: false, error: "Session path is required." };

	const persisted = loadPersistedSessionRouting();
	const previousName = findSessionNameByPath(input.sessionPath, persisted.sessions) ?? "(unnamed)";
	const named = setNamedSession(persisted.sessions, nextName, input.sessionPath);
	if (!named.ok) return { ok: false, error: named.error };

	persistSessionRouting({ sessions: named.sessions, aliases: persisted.aliases, archivedPaths: persisted.archivedPaths });
	appendSessionEvent("sess.rename", "admin", {
		from: previousName,
		to: nextName,
		path: input.sessionPath,
	});
	return { ok: true, from: previousName, to: nextName, sessionPath: input.sessionPath };
}

export type AddWakeAliasInput = {
	sessionPath: string;
	alias: string;
};

export type AddWakeAliasSuccess = {
	alias: string;
	replacedAlias?: string;
	sessionName: string;
	sessionPath: string;
};

export function normalizeAliasInput(raw: string): string {
	return raw.trim().replace(/\s+/g, " ");
}

export function addWakeAlias(input: AddWakeAliasInput): ActionResult<AddWakeAliasSuccess> {
	const alias = normalizeAliasInput(input.alias);
	if (!alias) return { ok: false, error: "Alias is required." };
	if (!input.sessionPath) return { ok: false, error: "Session path is required." };

	const persisted = loadPersistedSessionRouting();
	const sessionName = findSessionNameByPath(input.sessionPath, persisted.sessions) ?? "(unnamed)";
	const next = setWakeAlias(persisted.aliases, alias, input.sessionPath);
	persistSessionRouting({ sessions: persisted.sessions, aliases: next.aliases, archivedPaths: persisted.archivedPaths });
	appendSessionEvent("alias.add", "admin", {
		alias: next.alias,
		name: sessionName,
		path: input.sessionPath,
		...(next.replacedAlias ? { replacedAlias: next.replacedAlias } : {}),
	});
	return {
		ok: true,
		alias: next.alias,
		replacedAlias: next.replacedAlias,
		sessionName,
		sessionPath: input.sessionPath,
	};
}

export type RemoveWakeAliasInput = { alias: string };

export function removeWakeAlias(input: RemoveWakeAliasInput): ActionResult<{ alias: string }> {
	const alias = normalizeAliasInput(input.alias);
	if (!alias) return { ok: false, error: "Alias is required." };

	const persisted = loadPersistedSessionRouting();
	const cleared = clearWakeAlias(persisted.aliases, alias);
	if (!cleared.ok) return { ok: false, error: `Wake alias "${alias}" not found.` };
	persistSessionRouting({ sessions: persisted.sessions, aliases: cleared.aliases, archivedPaths: persisted.archivedPaths });
	appendSessionEvent("alias.remove", "admin", { alias: cleared.alias });
	return { ok: true, alias: cleared.alias };
}

export type PendingRemoval = {
	sessionPath: string;
	sessionName: string;
	requestedAt: number;
};

export type BeginRemoveSessionInput = {
	sessionPath: string;
	nowMs?: number;
};

export function beginRemoveSession(input: BeginRemoveSessionInput): ActionResult<PendingRemoval> {
	if (!input.sessionPath) return { ok: false, error: "Session path is required." };
	const persisted = loadPersistedSessionRouting();
	const sessionName = findSessionNameByPath(input.sessionPath, persisted.sessions);
	const aliases = listAliasesForSession(input.sessionPath, persisted.aliases);
	if (!sessionName && aliases.length === 0) {
		return { ok: false, error: "Session is not in the routing store; nothing to remove." };
	}
	return {
		ok: true,
		sessionPath: input.sessionPath,
		sessionName: sessionName ?? "(unnamed)",
		requestedAt: input.nowMs ?? Date.now(),
	};
}

export type ConfirmRemoveSessionInput = {
	pending: PendingRemoval | undefined;
	sessionPath: string;
	nowMs?: number;
	ttlMs?: number;
};

export type ConfirmRemoveSessionSuccess = {
	sessionPath: string;
	sessionName: string;
	removedNames: string[];
	removedAliases: string[];
};

export function confirmRemoveSession(
	input: ConfirmRemoveSessionInput,
): ActionResult<ConfirmRemoveSessionSuccess> {
	if (!input.pending) {
		return { ok: false, error: "No pending removal. Press x once to request, again to confirm." };
	}
	if (input.pending.sessionPath !== input.sessionPath) {
		return { ok: false, error: "Pending removal is for a different session. Re-request to confirm." };
	}
	const now = input.nowMs ?? Date.now();
	const ttl = input.ttlMs ?? REMOVE_CONFIRM_TTL_MS;
	if (now - input.pending.requestedAt > ttl) {
		return { ok: false, error: "Removal confirmation expired. Press x again to re-request." };
	}

	const persisted = loadPersistedSessionRouting();
	const removal = removeSessionRoutingForPath(
		persisted.sessions,
		persisted.aliases,
		input.sessionPath,
	);
	persistSessionRouting({
		sessions: removal.sessions,
		aliases: removal.aliases,
		archivedPaths: persisted.archivedPaths.filter((path) => path !== input.sessionPath),
	});
	appendSessionEvent("sess.remove", "admin", {
		name: input.pending.sessionName,
		path: input.sessionPath,
		removedAliases: removal.removedAliases,
	});
	return {
		ok: true,
		sessionPath: input.sessionPath,
		sessionName: input.pending.sessionName,
		removedNames: removal.removedNames,
		removedAliases: removal.removedAliases,
	};
}
