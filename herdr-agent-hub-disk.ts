import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, resolve as pathResolve } from "node:path";
import type { OhMyPiAgentHubDashboard } from "./agent-hub-dashboard.js";
import type { AgentHubBinding } from "./herdr-agent-hub-gateway.js";
import { type HubAgent, type HubAgentId, type HubFolder, parseHubAgentId } from "./herdr-agent-hub-schema.js";

/**
 * Disk-only fallback binding built from the agent-hub-dashboard stale-while-revalidate scan.
 * canMutate=false — chat/kill/revive answer 409 hub_offline.
 */
export function createDiskFallbackBinding(
	dashboardFn: () => OhMyPiAgentHubDashboard,
): AgentHubBinding {
	return {
		canMutate: false,
		async listAgents() {
			return buildSnapshotFromDashboard(dashboardFn());
		},
		async getAgent(id) {
			const { agents } = buildSnapshotFromDashboard(dashboardFn());
			return agents.find((agent) => agent.id === id);
		},
		async chat() { /* no-op: canMutate=false, gateway returns 409 */ },
		async kill() { /* no-op */ },
		async revive() { /* no-op */ },
		async readTranscript(id, fromByte) {
			const { agents } = buildSnapshotFromDashboard(dashboardFn());
			const agent = agents.find((candidate) => candidate.id === id);
			if (!agent?.sessionFile) return null;
			try {
				const stat = statSync(agent.sessionFile);
				if (fromByte >= stat.size) return { text: "", newSize: stat.size };
				const readLen = stat.size - fromByte;
				const buf = Buffer.allocUnsafe(readLen);
				const fd = openSync(agent.sessionFile, "r");
				try {
					readSync(fd, buf, 0, readLen, fromByte);
				} finally {
					closeSync(fd);
				}
				const raw = buf.toString("utf8");
				const lastNl = raw.lastIndexOf("\n");
				const complete = lastNl >= 0 ? raw.slice(0, lastNl + 1) : "";
				return { text: complete, newSize: fromByte + Buffer.byteLength(complete) };
			} catch {
				return null;
			}
		},
	};
}

function buildSnapshotFromDashboard(
	dashboard: OhMyPiAgentHubDashboard,
): { folders: readonly HubFolder[]; agents: readonly HubAgent[] } {
	const folderMap = new Map<string, HubFolder>();
	const agents: HubAgent[] = [];
	for (const session of dashboard.sessions) {
		const cwd = session.cwd ?? null;
		const key = cwd ?? "";
		const name = cwd ? basename(pathResolve(cwd)) || cwd : "(unknown folder)";
		const folder = folderMap.get(key);
		folderMap.set(key, {
			key,
			name,
			laneCount: (folder?.laneCount ?? 0) + 1,
			isCurrentFolder: folder?.isCurrentFolder || session.isCurrent,
		});

		const laneId = parseHubAgentId(session.name);
		if (!laneId) continue;
		agents.push(backgroundAgent(session, laneId, key, cwd));
		for (const sub of session.subagents ?? []) {
			const subId = parseHubAgentId(`${laneId}/${sub.id}`);
			if (!subId) continue;
			agents.push({
				id: subId,
				displayName: sub.id,
				kind: "sub",
				parentId: laneId,
				folderKey: key,
				depth: 2,
				status: "parked",
				model: null,
				cwd: null,
				activity: null,
				createdAtMs: sub.lastActivity,
				lastActivityMs: sub.lastActivity,
				needsAttention: false,
				attentionReason: null,
				sessionFile: sub.sessionPath,
			});
		}
	}
	return { folders: [...folderMap.values()], agents };
}

function backgroundAgent(
	session: OhMyPiAgentHubDashboard["sessions"][number],
	laneId: HubAgentId,
	folderKey: string,
	cwd: string | null,
): HubAgent {
	const now = Date.now();
	return {
		id: laneId,
		displayName: session.name,
		kind: "background",
		parentId: null,
		folderKey,
		depth: 1,
		status: "parked",
		model: session.model ?? null,
		cwd,
		activity: null,
		createdAtMs: session.createdAt ?? now,
		lastActivityMs: session.lastActivity ?? session.createdAt ?? now,
		needsAttention: false,
		attentionReason: null,
		sessionFile: session.sessionPath,
	};
}
