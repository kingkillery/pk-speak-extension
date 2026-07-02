// herdr-agent-hub-gateway.ts
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
	assertNever,
	type HubAgent,
	type HubAgentDetail,
	type HubAgentId,
	type HubFolder,
	parseHubAgentStatus,
} from "./herdr-agent-hub-schema.js";

export interface AgentHubBinding {
	listAgents(): Promise<{ folders: readonly HubFolder[]; agents: readonly HubAgent[] }>;
	getAgent(id: HubAgentId): Promise<HubAgent | undefined>;
	chat(id: HubAgentId, text: string): Promise<void>;
	kill(id: HubAgentId): Promise<void>;
	revive(id: HubAgentId): Promise<void>;
	readTranscript(id: HubAgentId, fromByte: number): Promise<{ text: string; newSize: number } | null>;
	readonly canMutate: boolean;
}

export type HubActionOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: number; readonly code: string; readonly error: string };

const CONFIRM_TTL_MS = 10_000;
const IDEMPOTENCY_TTL_MS = 60_000;
const STREAM_POLL_MS = 750;
const STREAM_HEARTBEAT_MS = 15_000;

interface PendingConfirm { readonly token: string; readonly expiresAt: number; }
interface StreamHandle { readonly res: ServerResponse; readonly stop: () => void; }

export class AgentHubGateway {
	readonly #binding: AgentHubBinding;
	readonly #confirms = new Map<HubAgentId, PendingConfirm>();
	readonly #idempotency = new Map<string, { messageId: string; expiresAt: number }>();
	readonly #streams = new Map<HubAgentId, StreamHandle>();

	constructor(binding: AgentHubBinding) {
		this.#binding = binding;
	}

	async snapshot(): Promise<{ folders: readonly HubFolder[]; agents: readonly HubAgent[] }> {
		return this.#binding.listAgents();
	}

	async detail(id: HubAgentId, tailLines: number): Promise<HubAgentDetail | undefined> {
		const agent = await this.#binding.getAgent(id);
		if (!agent) return undefined;
		const chunk = await this.#binding.readTranscript(id, 0);
		const lines = chunk ? chunk.text.split(/\r?\n/).filter(Boolean).slice(-tailLines) : [];
		return { ...agent, transcriptTail: lines, transcriptSize: chunk?.newSize ?? 0 };
	}

	async chat(
		id: HubAgentId,
		text: string,
		idempotencyKey: string | null,
	): Promise<{ ok: true; messageId: string } | HubActionOutcome> {
		if (!this.#binding.canMutate) return offline();
		if (!(await this.#binding.getAgent(id))) return notFound(id);
		if (idempotencyKey) {
			const seen = this.#idempotency.get(idempotencyKey);
			if (seen && seen.expiresAt > Date.now()) return { ok: true, messageId: seen.messageId };
		}
		await this.#binding.chat(id, text);
		const messageId = randomUUID();
		if (idempotencyKey) {
			this.#idempotency.set(idempotencyKey, { messageId, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
		}
		return { ok: true, messageId };
	}

	async revive(id: HubAgentId): Promise<HubActionOutcome> {
		if (!this.#binding.canMutate) return offline();
		const agent = await this.#binding.getAgent(id);
		if (!agent) return notFound(id);
		if (agent.status === "running" || agent.status === "idle") return { ok: true };
		await this.#binding.revive(id);
		return { ok: true };
	}

	async kill(
		id: HubAgentId,
		confirmToken: string | undefined,
	): Promise<
		| HubActionOutcome
		| { readonly ok: false; readonly status: 428; readonly code: "confirm_required"; readonly confirmToken: string; readonly expiresInMs: number }
	> {
		if (!this.#binding.canMutate) return offline();
		if (!(await this.#binding.getAgent(id))) return notFound(id);
		const pending = this.#confirms.get(id);
		if (!confirmToken) {
			const token = `k_${randomUUID().replaceAll("-", "")}`;
			this.#confirms.set(id, { token, expiresAt: Date.now() + CONFIRM_TTL_MS });
			return { ok: false, status: 428, code: "confirm_required", confirmToken: token, expiresInMs: CONFIRM_TTL_MS };
		}
		if (!pending || pending.token !== confirmToken || pending.expiresAt < Date.now()) {
			this.#confirms.delete(id);
			return { ok: false, status: 410, code: "confirm_expired", error: "Kill confirmation expired; request a new token." };
		}
		this.#confirms.delete(id);
		await this.#binding.kill(id);
		return { ok: true };
	}

	async stream(id: HubAgentId, res: ServerResponse, initialFromByte: number): Promise<void> {
		const previous = this.#streams.get(id);
		if (previous) {
			writeEvent(previous.res, "superseded", "{}");
			previous.stop();
		}

		let stopped = false;
		let wake: (() => void) | undefined;
		const stop = (): void => {
			stopped = true;
			wake?.();
		};
		this.#streams.set(id, { res, stop });
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write("retry: 3000\n\n");
		res.on("close", stop);

		let fromByte = initialFromByte;
		let lastStatus: string | undefined;
		let lastBeat = Date.now();
		try {
			while (!stopped) {
				const chunk = await this.#binding.readTranscript(id, fromByte);
				if (chunk && chunk.newSize > fromByte) {
					writeEvent(res, "append", JSON.stringify({ fromByte, newSize: chunk.newSize, text: chunk.text }));
					fromByte = chunk.newSize;
				}
				const agent = await this.#binding.getAgent(id);
				const status = agent ? parseHubAgentStatus(agent.status) : undefined;
				if (status && status !== lastStatus) {
					lastStatus = status;
					writeEvent(res, "status", JSON.stringify({ status, lastActivityMs: agent?.lastActivityMs ?? Date.now() }));
					switch (status) {
						case "running":
						case "idle":
						case "parked":
							break;
						case "aborted":
							stop();
							break;
						default:
							assertNever(status);
					}
				}
				if (Date.now() - lastBeat >= STREAM_HEARTBEAT_MS) {
					res.write(": heartbeat\n\n");
					lastBeat = Date.now();
				}
				const { promise, resolve } = Promise.withResolvers<void>();
				wake = resolve;
				const timer = setTimeout(resolve, STREAM_POLL_MS);
				await promise;
				clearTimeout(timer);
				wake = undefined;
			}
		} finally {
			if (this.#streams.get(id)?.res === res) this.#streams.delete(id);
			if (!res.writableEnded) res.end();
		}
	}
}

function writeEvent(res: ServerResponse, event: string, data: string): void {
	if (res.writableEnded) return;
	res.write(`event: ${event}\ndata: ${data}\n\n`);
}

function offline(): HubActionOutcome {
	return { ok: false, status: 409, code: "hub_offline", error: "No live Agent Hub host; gateway is in read-only disk mode." };
}

function notFound(id: HubAgentId): HubActionOutcome {
	return { ok: false, status: 404, code: "not_found", error: `Unknown agent: ${id}` };
}
