import {
	buildCompactRouteSlots,
	type CompactRouteSlot,
	type SessionDashboard,
	type SessionDashboardEntry,
	type SessionRoutingState,
} from "../session-routing.js";

export type AdminCliOptions = {
	showHelp: boolean;
	showSnapshot: boolean;
	currentSessionPath?: string;
	currentSessionName?: string;
};

export function parseAdminCliArgs(argv: string[]): AdminCliOptions {
	const args = argv.slice(2);
	const result: AdminCliOptions = { showHelp: false, showSnapshot: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			result.showHelp = true;
			continue;
		}
		if (arg === "--snapshot") {
			result.showSnapshot = true;
			continue;
		}
		if (arg === "--current-path") {
			const value = args[index + 1];
			if (value) {
				result.currentSessionPath = value;
				index += 1;
			}
			continue;
		}
		if (arg === "--current-name") {
			const value = args[index + 1];
			if (value) {
				result.currentSessionName = value;
				index += 1;
			}
		}
	}
	return result;
}

export function getFocusableSessionEntries(dashboard: SessionDashboard): SessionDashboardEntry[] {
	return dashboard.sessions.filter((entry) => !!entry.path);
}

export function getDefaultFocusedPath(dashboard: SessionDashboard): string | undefined {
	const focusable = getFocusableSessionEntries(dashboard);
	return focusable.find((entry) => entry.current)?.path ?? focusable[0]?.path;
}

export function ensureFocusedPath(
	dashboard: SessionDashboard,
	focusedPath?: string,
): string | undefined {
	const focusable = getFocusableSessionEntries(dashboard);
	if (focusable.length === 0) return undefined;
	if (focusedPath && focusable.some((entry) => entry.path === focusedPath)) return focusedPath;
	return getDefaultFocusedPath(dashboard);
}

export function moveFocusedPath(
	dashboard: SessionDashboard,
	focusedPath: string | undefined,
	delta: number,
): string | undefined {
	const focusable = getFocusableSessionEntries(dashboard);
	if (focusable.length === 0) return undefined;
	const current = ensureFocusedPath(dashboard, focusedPath);
	const currentIndex = focusable.findIndex((entry) => entry.path === current);
	const startIndex = currentIndex >= 0 ? currentIndex : 0;
	const nextIndex = (startIndex + delta + focusable.length) % focusable.length;
	return focusable[nextIndex]?.path;
}

export function findFocusedEntry(
	dashboard: SessionDashboard,
	focusedPath?: string,
): SessionDashboardEntry | undefined {
	const path = ensureFocusedPath(dashboard, focusedPath);
	if (!path) return undefined;
	return dashboard.sessions.find((entry) => entry.path === path);
}

export function buildPaneRoutingState(dashboard: SessionDashboard): SessionRoutingState {
	const sessions: Record<string, string> = {};
	const aliases: Record<string, string> = {};
	for (const entry of dashboard.sessions) {
		if (!entry.path) continue;
		sessions[entry.name] = entry.path;
		for (const alias of entry.aliases) aliases[alias] = entry.path;
	}
	return { sessions, aliases };
}

export function buildPaneCompactRouteSlots(dashboard: SessionDashboard): CompactRouteSlot[] {
	return buildCompactRouteSlots(buildPaneRoutingState(dashboard));
}

export function describeFocusedSessionSlots(
	entry: SessionDashboardEntry | undefined,
	slots: CompactRouteSlot[],
): string[] {
	if (!entry?.path) return [];
	return slots
		.filter((slot) => slot.sessionPath === entry.path && slot.status === "mapped")
		.map((slot) => `PK${slot.family}${slot.labels.length > 0 ? ` via ${slot.labels.join(", ")}` : ""}`);
}
