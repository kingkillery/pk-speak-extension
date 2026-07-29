// herdr-agent-hub-gateway.ts
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
	assertNever,
	statusOrder,
	type HubAgent,
	type HubAgentDetail,
	type HubAgentId,
	type HubAgentKind,
	type HubAgentStatus,
	type HubFolder,
	parseHubAgentStatus,
} from "./herdr-agent-hub-schema.js";
import {
	filterDigestTurns,
	parseSessionTranscript,
	type TranscriptDigest,
} from "./herdr-agent-hub-transcript.js";

export interface TranscriptRangeRead {
	/** Start from this byte offset instead of tailing the file. Clamped to [0, size]. */
	readonly fromByte?: number;
	/** Cap on bytes read. Defaults and upper bound are implementation-defined but bounded. */
	readonly maxBytes?: number;
}

export interface TranscriptChunk {
	readonly text: string;
	readonly newSize: number;
	/** Byte offset the chunk text actually starts at (after partial-line trimming). */
	readonly fromByte: number;
}

export interface AgentHubBinding {
	listAgents(): Promise<{ folders: readonly HubFolder[]; agents: readonly HubAgent[] }>;
	getAgent(id: HubAgentId): Promise<HubAgent | undefined>;
	chat(id: HubAgentId, text: string): Promise<void>;
	kill(id: HubAgentId): Promise<void>;
	revive(id: HubAgentId): Promise<void>;
	readTranscript(id: HubAgentId, fromByte: number): Promise<{ text: string; newSize: number } | null>;
	/**
	 * Bounded transcript read: never buffers more than maxBytes, and drops partial
	 * leading/trailing lines. Unlike readTranscript(fromByte=0) it is safe on
	 * multi-hundred-MB transcripts. Default (no fromByte) tails the file.
	 */
	readTranscriptRange(id: HubAgentId, opts?: TranscriptRangeRead): Promise<TranscriptChunk | null>;
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

export interface HubLaneBrief {
	readonly id: HubAgentId;
	readonly kind: HubAgentKind;
	readonly status: HubAgentStatus;
	readonly model?: string;
	/** ISO timestamp of the lane's most recent turn in the sampled tail. */
	readonly lastActivityAt?: string;
	/** Tool calls / tool errors observed in the sampled tail. */
	readonly recentToolCalls: number;
	readonly recentToolErrors: number;
	/** True when the sample was a mid-file tail: stats describe the tail only. */
	readonly sampledTail: boolean;
	/** True when the transcript could not be read at all. */
	readonly transcriptUnavailable?: boolean;
}

export interface HubBriefing {
	readonly generatedAt: number;
	readonly folders: number;
	readonly agents: number;
	/** Status counts across ALL agents, including unsampled ones. */
	readonly counts: Partial<Record<HubAgentStatus, number>>;
	readonly lanes: readonly HubLaneBrief[];
	/** True when agents beyond maxLanes received counts only, no tail sample. */
	readonly lanesCapped: boolean;
}

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
		// Bounded tail read: a full-file readTranscript(0) would buffer the entire
		// (potentially multi-hundred-MB) transcript just to keep a few lines.
		const chunk = await this.#binding.readTranscriptRange(id, {
			maxBytes: Math.min(Math.max(tailLines, 1) * 8192, 4 * 1024 * 1024),
		});
		if (!chunk) {
			// The agent exists but its transcript is unreadable — say so rather than
			// presenting a successful detail with an empty tail and size zero.
			return { ...agent, transcriptTail: [], transcriptSize: 0, transcriptUnavailable: true };
		}
		const lines = chunk.text.split(/\r?\n/).filter(Boolean).slice(-tailLines);
		return {
			...agent,
			transcriptTail: lines,
			transcriptSize: chunk.newSize,
			// The byte window clipped the tail (e.g. one record larger than the window),
			// so fewer lines than requested is a bounded-read artifact, not file end.
			...(chunk.fromByte > 0 && lines.length < tailLines ? { transcriptTailTruncated: true } : {}),
		};
	}

	/**
	 * Read-only distilled transcript digest for hub review. Tail-reads a bounded
	 * byte range, parses it into speech-friendly turns/stats, and back-fills lane
	 * metadata the tail can't see (the session header is record 0). Never exposes
	 * thinking content or raw jsonl.
	 *
	 * Result discrimination: `undefined` = no such agent; `null` = agent exists but
	 * its transcript is unreadable (deleted/locked/IO failure). Callers must not
	 * collapse the two into one error.
	 */
	async transcript(
		id: HubAgentId,
		opts: { maxBytes?: number; maxTurns?: number; query?: string } = {},
	): Promise<TranscriptDigest | null | undefined> {
		const agent = await this.#binding.getAgent(id);
		if (!agent) return undefined;
		const chunk = await this.#binding.readTranscriptRange(id, { maxBytes: opts.maxBytes });
		if (!chunk) return null;
		let digest = parseSessionTranscript(chunk.text, { maxTurns: opts.maxTurns });
		if (!digest.sessionId || !digest.cwd) {
			digest = {
				...digest,
				...(digest.sessionId ? {} : { sessionId: agent.id }),
				...(digest.cwd || !agent.cwd ? {} : { cwd: agent.cwd }),
			};
		}
		// A mid-file tail drops record 0 even when zero turns were dropped by maxTurns.
		if (chunk.fromByte > 0 && !digest.truncated) digest = { ...digest, truncated: true };
		// A trailing partial line (a record still being written) is dropped by the
		// reader; the digest must say it is not complete rather than look finished.
		const completeEnd = chunk.fromByte + Buffer.byteLength(chunk.text, "utf8");
		if (completeEnd < chunk.newSize && !digest.truncated) digest = { ...digest, truncated: true };
		if (opts.query) digest = filterDigestTurns(digest, opts.query);
		return digest;
	}

	/**
	 * Read-only standup briefing over the whole hub: status counts across every
	 * agent, plus a bounded tail sample (recent tool calls/errors, last activity,
	 * model) for the most relevant lanes. Every lane read goes through the bounded
	 * range reader, so cost stays flat regardless of transcript size.
	 */
	async briefing(
		opts: { maxLanes?: number; tailBytes?: number } = {},
	): Promise<HubBriefing> {
		const maxLanes = Math.min(Math.max(Math.trunc(opts.maxLanes ?? 12), 1), 50);
		const tailBytes = Math.min(Math.max(Math.trunc(opts.tailBytes ?? 32 * 1024), 4096), 256 * 1024);
		const { folders, agents } = await this.#binding.listAgents();

		const counts: Partial<Record<HubAgentStatus, number>> = {};
		for (const agent of agents) {
			counts[agent.status] = (counts[agent.status] ?? 0) + 1;
		}

		// Most relevant first: running lanes, then idle/parked/aborted, stable by id.
		const ranked = [...agents].sort(
			(a, b) => statusOrder(a.status) - statusOrder(b.status) || a.id.localeCompare(b.id),
		);
		const sampled = ranked.slice(0, maxLanes);
		const lanes: HubLaneBrief[] = [];
		for (const agent of sampled) {
			const chunk = await this.#binding.readTranscriptRange(agent.id, { maxBytes: tailBytes });
			if (!chunk) {
				lanes.push({
					id: agent.id, kind: agent.kind, status: agent.status,
					recentToolCalls: 0, recentToolErrors: 0, sampledTail: false,
					transcriptUnavailable: true,
				});
				continue;
			}
			const digest = parseSessionTranscript(chunk.text, { maxTurns: 25 });
			const lastTurn = digest.turns[digest.turns.length - 1];
			lanes.push({
				id: agent.id,
				kind: agent.kind,
				status: agent.status,
				...(digest.model ? { model: digest.model } : {}),
				...(lastTurn?.at ? { lastActivityAt: lastTurn.at } : {}),
				recentToolCalls: digest.stats.toolCalls,
				recentToolErrors: digest.stats.toolErrors,
				sampledTail: chunk.fromByte > 0 || digest.truncated,
			});
		}

		return {
			generatedAt: Date.now(),
			folders: folders.length,
			agents: agents.length,
			counts,
			lanes,
			lanesCapped: agents.length > sampled.length,
		};
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
		try {
			await this.#binding.chat(id, text);
		} catch (error) {
			return rejected(error);
		}
		const messageId = randomUUID();
		if (idempotencyKey) {
			this.#idempotency.set(idempotencyKey, { messageId, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
		}
		return { ok: true, messageId };
	}

	async revive(id: HubAgentId): Promise<HubActionOutcome> {
		if (!this.#binding.canMutate) return offline();
		// Deliberately does NOT 404 on a missing getAgent(id) result before trying the binding:
		// a revivable (archived) lane is, by definition, invisible to the active-lane scan that
		// getAgent() reads, so getAgent() finding nothing is the EXPECTED shape of the one case
		// revive exists for. Only an agent that IS visible and already alive short-circuits here;
		// everything else is left to the binding, which 404s itself via a thrown "not found".
		const agent = await this.#binding.getAgent(id);
		if (agent && (agent.status === "running" || agent.status === "idle")) return { ok: true };
		try {
			await this.#binding.revive(id);
		} catch (error) {
			return rejected(error);
		}
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
		try {
			await this.#binding.kill(id);
		} catch (error) {
			return rejected(error);
		}
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

function rejected(error: unknown): HubActionOutcome {
	return { ok: false, status: 400, code: "action_rejected", error: error instanceof Error ? error.message : String(error) };
}
