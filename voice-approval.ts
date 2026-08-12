// Voice approval registry.
//
// Generic in-flight approval gate used by both agent providers (Pi
// `tool_call` and Codex `item/*/requestApproval`) to suspend a turn until
// the operator says yes or no. The gate is consumed by the existing voice
// confirmation parser in routeVoiceInput.
//
// One slot at a time on purpose: agents typically pause a turn on a single
// approval request; if a second arrives while one is already pending, we
// auto-decline the new one and surface why. Keeps the spoken prompt and the
// resolution contract simple.

export type ApprovalDecision = "accept" | "decline";

export type PendingApproval = {
	id: string;
	description: string;
	spokenPrompt: string;
	resolve: (decision: ApprovalDecision) => void;
	expiresAt: number;
};

export type RequestApprovalInput = {
	description: string;
	spokenPrompt?: string;
	timeoutMs?: number;
	now?: () => number;
	onTimeout?: ApprovalDecision; // default "decline"
};

const DEFAULT_TIMEOUT_MS = 30_000;
let nextId = 1;

export function createApprovalRegistry(now: () => number = Date.now) {
	let pending: PendingApproval | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clear = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		pending = undefined;
	};

	const get = () => {
		if (!pending) return undefined;
		if (now() > pending.expiresAt) {
			const expired = pending;
			expired.resolve("decline");
			clear();
			return undefined;
		}
		return pending;
	};

	const request = (input: RequestApprovalInput): Promise<ApprovalDecision> => {
		// Auto-decline a stacked request rather than replacing the in-flight one.
		// Caller (e.g. tool_call handler) will block the new tool with this signal.
		if (pending) return Promise.resolve("decline");

		const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const onTimeout = input.onTimeout ?? "decline";
		const id = `apv-${nextId++}`;
		const description = input.description;
		const spokenPrompt = input.spokenPrompt ?? `Approve ${description}? Say yes or no.`;

		return new Promise<ApprovalDecision>((resolve) => {
			pending = {
				id,
				description,
				spokenPrompt,
				resolve,
				expiresAt: (input.now ?? now)() + timeoutMs,
			};
			timer = setTimeout(() => {
				if (pending && pending.id === id) {
					pending.resolve(onTimeout);
					clear();
				}
			}, timeoutMs);
			// NOTE: intentionally ref'd. A pending approval means an operator
			// decision is genuinely awaited; unref() let the event loop drain
			// when this was the only pending handle, so the onTimeout resolve
			// never fired and the request hung forever (confirmed by the
			// voice-approval tests). Declining on timeout is a real safety
			// guard that must run.
		});
	};

	const accept = () => {
		const entry = get();
		if (!entry) return undefined;
		entry.resolve("accept");
		clear();
		return entry;
	};

	const decline = () => {
		const entry = get();
		if (!entry) return undefined;
		entry.resolve("decline");
		clear();
		return entry;
	};

	return { request, get, accept, decline };
}

export type ApprovalRegistry = ReturnType<typeof createApprovalRegistry>;
