// Per-client oh-my-pk resume-session selection.
//
// Replaces the previous process-global `activeOmpSessionPath`, which leaked one
// client's selection into every other client's turns on a multi-client gateway
// (review finding C1) and could never be cleared (C2). Selections are keyed by a
// stable per-client key (remote address + token, or an explicit client id) so
// distinct devices stay isolated, and a client can deselect to return to normal
// routing.
//
// Paths are compared on their resolved form so the M3 auto-archive guard
// (`isActive`) still matches when the dashboard scanner and the client-supplied
// selection spell the same file differently (separators, `..`, relative vs
// absolute). On Windows the resolved form is also lower-cased, since the file
// system is case-insensitive there.

import { resolve, sep } from "node:path";

function normalizePath(sessionPath: string): string {
	const resolved = resolve(sessionPath);
	return sep === "\\" ? resolved.toLowerCase() : resolved;
}
const DEFAULT_CLIENT_KEY = "default";

export class OmpSelectionStore {
	private readonly byClient = new Map<string, string>();

	/** Select (sessionPath) or deselect (null/empty) the omp session for a client. */
	select(clientKey: string | undefined, sessionPath: string | null): void {
		const key = clientKey?.trim() || DEFAULT_CLIENT_KEY;
		const path = sessionPath?.trim();
		if (path) {
			this.byClient.set(key, path);
		} else {
			this.byClient.delete(key);
		}
	}

	/** The omp session selected by this client, or null. */
	get(clientKey: string | undefined): string | null {
		const key = clientKey?.trim() || DEFAULT_CLIENT_KEY;
		return this.byClient.get(key) ?? null;
	}

	/** True if any client currently has this session path selected. */
	isActive(sessionPath: string | undefined): boolean {
		if (!sessionPath?.trim()) return false;
		const target = normalizePath(sessionPath.trim());
		for (const path of this.byClient.values()) {
			if (normalizePath(path) === target) return true;
		}
		return false;
	}
}
