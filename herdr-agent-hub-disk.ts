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
				let bytesRead: number;
				try {
					// Decode only bytes actually read: a truncate/rotation between stat
					// and read leaves the allocUnsafe tail as stale memory.
					bytesRead = readSync(fd, buf, 0, readLen, fromByte);
				} finally {
					closeSync(fd);
				}
				const bytes = buf.subarray(0, bytesRead);
				// Byte-level trailing trim: a split multibyte char at the cut would decode
				// to U+FFFD and corrupt byte accounting; keep everything in bytes.
				const lastNl = bytes.lastIndexOf(0x0a);
				const complete = lastNl >= 0 ? bytes.subarray(0, lastNl + 1) : bytes.subarray(0, 0);
				return { text: complete.toString("utf8"), newSize: fromByte + complete.length };
			} catch {
				return null;
			}
		},
		async readTranscriptRange(id, opts = {}) {
			const { agents } = buildSnapshotFromDashboard(dashboardFn());
			const agent = agents.find((candidate) => candidate.id === id);
			if (!agent?.sessionFile) return null;
			try {
				const stat = statSync(agent.sessionFile);
				const maxBytes = Math.min(
					Math.max(Math.trunc(opts.maxBytes ?? DEFAULT_RANGE_READ_BYTES), 1024),
					MAX_RANGE_READ_BYTES,
				);
				const requestedFrom = typeof opts.fromByte === "number" && Number.isFinite(opts.fromByte)
					? Math.min(Math.max(Math.trunc(opts.fromByte), 0), stat.size)
					: Math.max(0, stat.size - maxBytes);
				const readLen = Math.min(maxBytes, stat.size - requestedFrom);
				if (readLen <= 0) return { text: "", newSize: stat.size, fromByte: stat.size };
				const buf = Buffer.allocUnsafe(readLen);
				const fd = openSync(agent.sessionFile, "r");
				let bytesRead: number;
				let startsAtLineBoundary = false;
				try {
					// Decode only bytes actually read: a truncate/rotation between stat
					// and read leaves the allocUnsafe tail as stale memory.
					bytesRead = readSync(fd, buf, 0, readLen, requestedFrom);
					if (requestedFrom > 0 && bytesRead > 0) {
						// A start exactly at a line boundary (previous byte is "\n", which
						// also covers CRLF) means the first line is complete, not partial.
						const prev = Buffer.allocUnsafe(1);
						startsAtLineBoundary = readSync(fd, prev, 0, 1, requestedFrom - 1) === 1 && prev[0] === 0x0a;
					}
				} finally {
					closeSync(fd);
				}
				const bytes = buf.subarray(0, bytesRead);
				let fromByte = requestedFrom;
				let start = 0;
				// A genuinely mid-line start lands inside a jsonl record; drop the partial
				// leading line so the parser never sees truncated JSON. Newline detection
				// stays in bytes — a split multibyte char decodes to U+FFFD and would make
				// string-index offsets diverge from file byte offsets.
				if (fromByte > 0 && !startsAtLineBoundary) {
					const firstNl = bytes.indexOf(0x0a);
					if (firstNl < 0) return { text: "", newSize: stat.size, fromByte: stat.size };
					start = firstNl + 1;
					fromByte += start;
				}
				const lastNl = bytes.lastIndexOf(0x0a);
				const complete = lastNl >= start ? bytes.subarray(start, lastNl + 1) : bytes.subarray(start, start);
				return { text: complete.toString("utf8"), newSize: stat.size, fromByte };
			} catch {
				return null;
			}
		},
	};
}

const DEFAULT_RANGE_READ_BYTES = 256 * 1024;
const MAX_RANGE_READ_BYTES = 1024 * 1024;

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
			// sub.id embeds the dashboard lane id ("background:<sessionId>/<name>"),
			// whose colon can never pass parseHubAgentId — every subagent used to be
			// silently dropped here. The hub id is the lane-scoped bare name instead.
			const subId = parseHubAgentId(`${laneId}/${sub.name}`);
			if (!subId) continue;
			agents.push({
				id: subId,
				displayName: sub.name,
				kind: "sub",
				parentId: laneId,
				folderKey: key,
				depth: 2,
				status: "parked",
				model: null,
				cwd: null,
				activity: null,
				description: "background subagent",
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
		description: session.role ?? null,
		createdAtMs: session.createdAt ?? now,
		lastActivityMs: session.lastActivity ?? session.createdAt ?? now,
		needsAttention: false,
		attentionReason: null,
		sessionFile: session.sessionPath,
	};
}
