export type RealtimeTerminalApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type RealtimeTerminalApproval = {
	id: string;
	command: string;
	reason: string;
	requestedAt: number;
	expiresAt: number;
	status: RealtimeTerminalApprovalStatus;
};

const DEFAULT_TIMEOUT_MS = 60_000;
let nextApprovalId = 1;

export function createRealtimeTerminalApprovalRegistry(
	now: () => number = Date.now,
	options: { timeoutMs?: number } = {},
) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pending = new Map<string, RealtimeTerminalApproval>();

	const pruneExpired = () => {
		const current = now();
		for (const [id, approval] of pending) {
			if (approval.expiresAt <= current) {
				approval.status = "expired";
				pending.delete(id);
			}
		}
	};

	const request = (command: string, reason: string) => {
		pruneExpired();
		const requestedAt = now();
		const approval: RealtimeTerminalApproval = {
			id: `rt-term-${nextApprovalId++}`,
			command,
			reason,
			requestedAt,
			expiresAt: requestedAt + timeoutMs,
			status: "pending",
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

export type RealtimeTerminalApprovalRegistry = ReturnType<typeof createRealtimeTerminalApprovalRegistry>;
