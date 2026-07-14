export type RealtimeCommandProposalCategory =
	| "terminal"
	| "chat"
	| "kill"
	| "launch"
	| "archive"
	| "multi-step";

export type RealtimeCommandApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type RealtimeCommandApproval = {
	id: string;
	category: RealtimeCommandProposalCategory;
	command: string;
	description: string;
	requestedAt: number;
	expiresAt: number;
	status: RealtimeCommandApprovalStatus;
	args?: Record<string, unknown>;
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

	const request = (
		category: RealtimeCommandProposalCategory,
		command: string,
		description: string,
		args?: Record<string, unknown>,
	) => {
		pruneExpired();
		const requestedAt = now();
		const approval: RealtimeCommandApproval = {
			id: `rt-cmd-${nextApprovalId++}`,
			category,
			command,
			description,
			requestedAt,
			expiresAt: requestedAt + timeoutMs,
			status: "pending",
			args,
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
