<<<<<<< HEAD
export type RealtimeCommandProposalCategory =
	| "terminal"
	| "chat"
	| "kill"
	| "launch"
	| "archive"
	| "multi-step";
=======
// Separate from realtime-terminal-approval.ts (which is keyed on a raw shell
// command string) so this can cover any mutating tool call — currently
// launching an agent or archiving/recovering a session — behind one
// kind+description shape without reshaping the terminal flow.
export type RealtimeCommandKind = "launch_agent" | "archive_session";
>>>>>>> origin/main

export type RealtimeCommandApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type RealtimeCommandApproval = {
	id: string;
<<<<<<< HEAD
	category: RealtimeCommandProposalCategory;
	command: string;
=======
	kind: RealtimeCommandKind;
>>>>>>> origin/main
	description: string;
	requestedAt: number;
	expiresAt: number;
	status: RealtimeCommandApprovalStatus;
<<<<<<< HEAD
	args?: Record<string, unknown>;
=======
>>>>>>> origin/main
};

const DEFAULT_TIMEOUT_MS = 60_000;
let nextApprovalId = 1;

export function createRealtimeCommandApprovalRegistry(
	now: () => number = Date.now,
	options: { timeoutMs?: number } = {},
) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pending = new Map<string, RealtimeCommandApproval>();

	const pruneExpired = () => {
		const current = now();
		for (const [id, approval] of pending) {
			if (approval.expiresAt <= current) {
				approval.status = "expired";
				pending.delete(id);
			}
		}
	};

<<<<<<< HEAD
	const request = (
		category: RealtimeCommandProposalCategory,
		command: string,
		description: string,
		args?: Record<string, unknown>,
	) => {
=======
	const request = (kind: RealtimeCommandKind, description: string) => {
>>>>>>> origin/main
		pruneExpired();
		const requestedAt = now();
		const approval: RealtimeCommandApproval = {
			id: `rt-cmd-${nextApprovalId++}`,
<<<<<<< HEAD
			category,
			command,
=======
			kind,
>>>>>>> origin/main
			description,
			requestedAt,
			expiresAt: requestedAt + timeoutMs,
			status: "pending",
<<<<<<< HEAD
			args,
=======
>>>>>>> origin/main
		};
		pending.set(approval.id, approval);
		return approval;
	};

	const get = (id: string | undefined) => {
		if (!id) return undefined;
		pruneExpired();
		return pending.get(id);
	};

	const list = () => {
		pruneExpired();
		return [...pending.values()];
	};

	const resolve = (id: string | undefined, approved: boolean) => {
		const approval = get(id);
		if (!approval) return undefined;
		approval.status = approved ? "approved" : "rejected";
		pending.delete(approval.id);
		return approval;
	};

	const expire = (id: string | undefined) => {
		if (!id) return undefined;
		const approval = pending.get(id);
		if (!approval) return undefined;
		approval.status = "expired";
		pending.delete(approval.id);
		return approval;
	};

	return { request, get, list, resolve, expire };
}

export type RealtimeCommandApprovalRegistry = ReturnType<typeof createRealtimeCommandApprovalRegistry>;
