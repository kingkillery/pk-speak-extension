// herdr-agent-hub-live.ts — a real (mutating) AgentHubBinding built from already-shipped
// primitives: turn submission (chat), archive (kill), recover (revive). It deliberately does
// NOT invent new IPC with the external oh-my-pk binary or attempt raw OS process termination —
// those would be guesses about an undocumented external tool. Instead it composes the same
// turn-routing and archive/recover mechanisms the terminal `/sess` commands and the older
// `/v1/sessions/*` endpoints already use in production.
import { archiveOhMyPiBackgroundSession, recoverOhMyPiBackgroundSession } from "./agent-hub-actions.js";
import { findOhMyPiBackgroundSessionPath, type BuildOhMyPiAgentHubDashboardOptions, type OhMyPiAgentHubDashboard } from "./agent-hub-dashboard.js";
import { createDiskFallbackBinding } from "./herdr-agent-hub-disk.js";
import type { AgentHubBinding } from "./herdr-agent-hub-gateway.js";

export type LiveAgentHubDeps = {
	/** Same dashboard source the read-only disk fallback uses. */
	dashboardFn: () => OhMyPiAgentHubDashboard;
	/**
	 * Submits a normal turn targeted at a named session, exactly like typing `PK <session-name>`
	 * or posting to `/v1/turn/text` with `target` set. The reply streams back through the same
	 * session jsonl file the hub's transcript tail already reads, so no separate reply channel
	 * is needed here.
	 */
	submitChatTurn: (text: string, target: string, cwd: string | undefined) => Promise<unknown>;
	/** Root/env options matching whatever dashboardFn scanned, used to resolve an already-archived
	 * lane back to a file path for revive() (archived lanes are invisible to dashboardFn itself). */
	lookupOptions?: BuildOhMyPiAgentHubDashboardOptions;
};

/**
 * A live AgentHubBinding for top-level oh-my-pk background lanes (`kind: "background"`).
 * Subagents (`kind: "sub"`) are nested records with no independent routing target or session
 * header of their own, so chat/kill/revive on them are honestly rejected rather than faked.
 *
 * - chat(): submits a real turn via submitChatTurn, targeted at the lane's session name.
 * - kill(): archives the lane (same effect as `/v1/sessions/archive`), not a process signal.
 * - revive(): recovers the lane's archived metadata (same effect as `/v1/sessions/archive?action=recover`).
 */
export function createLiveAgentHubBinding(deps: LiveAgentHubDeps): AgentHubBinding {
	const disk = createDiskFallbackBinding(deps.dashboardFn);
	return {
		canMutate: true,
		listAgents: disk.listAgents,
		getAgent: disk.getAgent,
		readTranscript: disk.readTranscript,
		readTranscriptRange: disk.readTranscriptRange,
		async chat(id, text) {
			const agent = await disk.getAgent(id);
			if (!agent) return;
			if (agent.kind !== "background") {
				throw new Error("Subagents are read-only in this version; chat with the parent lane instead.");
			}
			await deps.submitChatTurn(text, agent.displayName, agent.cwd ?? undefined);
		},
		async kill(id) {
			const agent = await disk.getAgent(id);
			if (!agent) return;
			if (agent.kind !== "background" || !agent.sessionFile) {
				throw new Error("Only top-level background lanes can be archived from the hub.");
			}
			const result = archiveOhMyPiBackgroundSession(agent.sessionFile);
			if (!result.ok) throw new Error(result.message);
		},
		async revive(id) {
			// An archived lane is intentionally invisible to disk.getAgent()/dashboardFn (that's
			// what "archived" means to buildOhMyPiAgentHubDashboard), so revive must resolve the
			// id back to a file directly rather than looking it up in the live agent list.
			const sessionFile = findOhMyPiBackgroundSessionPath(id, deps.lookupOptions);
			if (!sessionFile) throw new Error(`No archived background lane named "${id}" was found.`);
			const result = recoverOhMyPiBackgroundSession(sessionFile);
			if (!result.ok) throw new Error(result.message);
		},
	};
}
