import {
	buildSessionDashboard,
	type BuildSessionDashboardOptions,
	type SessionDashboard,
	type SessionDashboardEntry,
	type SessionRuntimeSnapshot,
} from "../session-routing.js";
import {
	getSessionRoutingStorePath,
	loadPersistedSessionRouting,
} from "../session-routing-store.js";
import { readAttentionSnapshots } from "../attention-broker.js";

export type LoadSessionDashboardOptions = {
	runtimeSnapshots?: SessionRuntimeSnapshot[];
	currentSessionPath?: string;
	currentSessionName?: string;
	currentBusy?: boolean;
	currentReady?: boolean;
	storePath?: string;
};

export function loadSessionDashboard(options: LoadSessionDashboardOptions = {}): SessionDashboard {
	const persisted = loadPersistedSessionRouting();
	const snapshots = options.runtimeSnapshots ?? readAttentionSnapshots();
	const dashboardOptions: BuildSessionDashboardOptions = {
		sessions: persisted.sessions,
		aliases: persisted.aliases,
		runtimeSnapshots: snapshots,
		currentSessionPath: options.currentSessionPath,
		currentSessionName: options.currentSessionName,
		currentBusy: options.currentBusy,
		currentReady: options.currentReady,
		storePath: options.storePath ?? getSessionRoutingStorePath(),
	};
	return buildSessionDashboard(dashboardOptions);
}

export function projectDashboardRow(entry: SessionDashboardEntry) {
	const tags: string[] = [];
	if (entry.current) tags.push("current");
	if (entry.ready) tags.push("ready");
	tags.push(entry.activity);
	return {
		name: entry.name,
		path: entry.path,
		marker: entry.current ? ">" : " ",
		tags,
		aliases: entry.aliases,
	};
}

export function projectDashboardLines(dashboard: SessionDashboard): string[] {
	const lines: string[] = [];
	lines.push(`pi-speak session manager    store: ${dashboard.storePath ?? "(unset)"}`);
	lines.push("");
	lines.push(`Current: ${dashboard.current}`);
	lines.push(`Ready:   ${dashboard.ready.length > 0 ? dashboard.ready.join(", ") : "none"}`);
	lines.push("");
	if (dashboard.sessions.length === 0) {
		lines.push("(no sessions)");
	} else {
		const nameWidth = Math.max(16, ...dashboard.sessions.map((entry) => entry.name.length));
		for (const entry of dashboard.sessions) {
			const row = projectDashboardRow(entry);
			const tagText = row.tags.map((tag) => `[${tag}]`).join(" ");
			const aliasText = row.aliases.length > 0 ? `aliases: ${row.aliases.join(", ")}` : "";
			const line = `${row.marker} ${entry.name.padEnd(nameWidth)}  ${tagText}${aliasText ? `  ${aliasText}` : ""}`;
			lines.push(line.replace(/\s+$/, ""));
		}
	}
	return lines;
}
