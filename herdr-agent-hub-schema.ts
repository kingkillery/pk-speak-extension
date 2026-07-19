// herdr-agent-hub-schema.ts — parse-not-validate boundary for /v1/herdr/agent* routes.
declare const HUB_AGENT_ID_BRAND: unique symbol;
export type HubAgentId = string & { readonly [HUB_AGENT_ID_BRAND]: true };

export type HubAgentStatus = "running" | "idle" | "parked" | "aborted";
export type HubAgentKind = "main" | "sub" | "advisor" | "background";

export interface HubFolder {
	readonly key: string;
	readonly name: string;
	readonly laneCount: number;
	readonly isCurrentFolder: boolean;
}

export interface HubAgent {
	readonly id: HubAgentId;
	readonly displayName: string;
	readonly kind: HubAgentKind;
	readonly parentId: HubAgentId | null;
	readonly folderKey: string;
	readonly depth: number;
	readonly status: HubAgentStatus;
	readonly model: string | null;
	readonly cwd: string | null;
	readonly activity: string | null;
	readonly createdAtMs: number;
	readonly lastActivityMs: number;
	readonly needsAttention: boolean;
	readonly attentionReason: string | null;
	readonly sessionFile: string | null;
}

export interface HubAgentDetail extends HubAgent {
	readonly transcriptTail: readonly string[];
	readonly transcriptSize: number;
}

export interface HubChatRequest {
	readonly text: string;
	readonly idempotencyKey: string | null;
}

export interface HubKillConfirm {
	readonly confirmToken: string;
}

const HUB_AGENT_ID_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,199}$/;

function isHubAgentId(value: string): value is HubAgentId {
	return HUB_AGENT_ID_PATTERN.test(value);
}

export function parseHubAgentId(value: string | undefined | null): HubAgentId | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && isHubAgentId(trimmed) ? trimmed : undefined;
}

const HUB_STATUSES: readonly HubAgentStatus[] = ["running", "idle", "parked", "aborted"];

export function parseHubAgentStatus(value: unknown): HubAgentStatus | undefined {
	if (typeof value !== "string") return undefined;
	for (const status of HUB_STATUSES) {
		if (status === value) return status;
	}
	return undefined;
}

const MAX_CHAT_TEXT = 8192;

export function parseHubChatRequest(
	payload: Record<string, unknown> | undefined,
	idempotencyHeader: string | undefined,
): HubChatRequest | undefined {
	const raw = payload?.text;
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	if (!text || text.length > MAX_CHAT_TEXT) return undefined;
	const idempotencyKey =
		typeof idempotencyHeader === "string" && /^[\w-]{8,128}$/.test(idempotencyHeader)
			? idempotencyHeader
			: null;
	return { text, idempotencyKey };
}

export function parseHubKillConfirm(payload: Record<string, unknown> | undefined): HubKillConfirm | undefined {
	const token = payload?.confirmToken;
	return typeof token === "string" && /^k_[\w-]{16,64}$/.test(token) ? { confirmToken: token } : undefined;
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

export function statusOrder(status: HubAgentStatus): number {
	switch (status) {
		case "running": return 0;
		case "idle": return 1;
		case "parked": return 2;
		case "aborted": return 3;
		default: return assertNever(status);
	}
}
