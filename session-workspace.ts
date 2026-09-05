import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import {
	focusHerdrAgent,
	listHerdrAgents,
	promptHerdrAgent,
	readHerdrAgent,
	type HerdrAgentActionResult,
	type HerdrAgentInfo,
	type HerdrAgentListResult,
	type HerdrAgentReadResult,
	type HerdrAgentSessionInfo,
	type HerdrAgentStatus,
} from "./herdr-client.js";
import { getPiSpeakConfigDir } from "./setup-config.js";

export type SessionWorkspaceStatus = HerdrAgentStatus;
export type SessionWorkspaceAvailability = "live";

export type SessionWorkspaceNativeSession = {
	readonly source: string;
	readonly agent: string;
	readonly kind: "id" | "path";
};

export type SessionWorkspaceSession = {
	readonly id: string;
	readonly displayName: string;
	readonly provider: string;
	readonly status: SessionWorkspaceStatus;
	readonly availability: SessionWorkspaceAvailability;
	readonly cwd?: string;
	readonly foregroundCwd?: string;
	readonly focused: boolean;
	readonly interactiveReady: boolean;
	readonly launchPending: boolean;
	readonly revision: number;
	readonly stateChangeSeq: number;
	readonly nativeSession?: SessionWorkspaceNativeSession;
	readonly capabilities: {
		readonly prompt: boolean;
		readonly focus: boolean;
		readonly resume: boolean;
	};
};

export type SessionWorkspaceSnapshot = {
	readonly source: "herdr";
	readonly generatedAtMs: number;
	readonly available: boolean;
	readonly executable?: string;
	readonly error?: string;
	readonly sessions: readonly SessionWorkspaceSession[];
};

export type SessionWorkspaceDetail = {
	readonly session: SessionWorkspaceSession;
	readonly tail: {
		readonly text: string;
		readonly lines: readonly string[];
		readonly truncated: boolean;
	};
};

export type SessionWorkspaceError = {
	readonly ok: false;
	readonly status: number;
	readonly code: string;
	readonly error: string;
};

export type SessionWorkspaceActionResult =
	| {
		readonly ok: true;
		readonly action: "prompt" | "focus" | "resume";
		readonly session: SessionWorkspaceSession;
		readonly commandId: string;
		readonly replayed?: boolean;
		readonly alreadyActive?: boolean;
	}
	| SessionWorkspaceError;

export type SessionWorkspaceDetailResult =
	| { readonly ok: true; readonly detail: SessionWorkspaceDetail }
	| SessionWorkspaceError;

export type SessionWorkspaceClient = {
	listAgents(): Promise<HerdrAgentListResult>;
	readAgent(target: string, lines: number): Promise<HerdrAgentReadResult>;
	promptAgent(target: string, text: string): Promise<HerdrAgentActionResult>;
	focusAgent(target: string): Promise<HerdrAgentActionResult>;
};

type SessionWorkspaceDeps = Partial<SessionWorkspaceClient> & {
	readonly now?: () => number;
	readonly mutationStorePath?: string;
};

type StoredMutation = {
	readonly fingerprint: string;
	readonly status: "pending" | "completed";
	readonly result?: Extract<SessionWorkspaceActionResult, { ok: true }>;
	readonly expiresAt: number;
};

type StoredMutationRecord = StoredMutation & { readonly key: string };

type MutationStoreFile = {
	readonly version: number;
	readonly mutations: readonly StoredMutationRecord[];
};

const MAX_PROMPT_CHARS = 8192;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const MUTATION_STORE_VERSION = 1;
const WORKSPACE_ACTIONS: Record<string, true> = { prompt: true, focus: true, resume: true };
const DEFINITE_ACTION_FAILURES: Record<string, true> = {
	target_not_found: true,
	agent_not_found: true,
	agent_not_ready: true,
	target_busy: true,
	empty_agent_prompt: true,
};
const STREAM_POLL_MS = 2000;
const STREAM_HEARTBEAT_MS = 15000;

export class SessionWorkspaceService {
	readonly #client: SessionWorkspaceClient;
	readonly #now: () => number;
	readonly #mutationStorePath: string;
	readonly #mutations = new Map<string, StoredMutation>();
	#mutationChain: Promise<void> = Promise.resolve();

	constructor(deps: SessionWorkspaceDeps = {}) {
		this.#client = {
			listAgents: deps.listAgents ?? (() => listHerdrAgents()),
			readAgent: deps.readAgent ?? ((target, lines) => readHerdrAgent(target, lines)),
			promptAgent: deps.promptAgent ?? ((target, text) => promptHerdrAgent(target, text)),
			focusAgent: deps.focusAgent ?? ((target) => focusHerdrAgent(target)),
		};
		this.#now = deps.now ?? Date.now;
		this.#mutationStorePath = deps.mutationStorePath ?? join(getPiSpeakConfigDir(), "session-workspace-mutations.json");
		this.loadMutations();
	}

	async snapshot(): Promise<SessionWorkspaceSnapshot> {
		const result = await this.#client.listAgents();
		if (!result.ok) {
			return {
				source: "herdr",
				generatedAtMs: this.#now(),
				available: false,
				executable: result.executable,
				error: result.error,
				sessions: [],
			};
		}
		return {
			source: "herdr",
			generatedAtMs: this.#now(),
			available: true,
			executable: result.executable,
			sessions: result.agents.map((agent) => toSession(agent)),
		};
	}

	async detail(id: string, lines = 80): Promise<SessionWorkspaceDetailResult> {
		const normalizedLines = Math.min(Math.max(Math.trunc(lines), 1), 200);
		const found = await this.findSession(id);
		if (!found.ok) return found;
		const read = await this.#client.readAgent(found.agent.pane_id, normalizedLines);
		if (!read.ok) {
			return {
				ok: false,
				status: read.code === "target_not_found" || read.code === "agent_not_found" ? 404 : 502,
				code: read.code || "read_failed",
				error: read.error || read.message,
			};
		}
		const text = read.text || "";
		return {
			ok: true,
			detail: {
				session: found.session,
				tail: {
					text,
					lines: text.split(/\r?\n/).filter(Boolean).slice(-normalizedLines),
					truncated: read.truncated === true,
				},
			},
		};
	}

	async prompt(
		id: string,
		text: unknown,
		expectedRevision: unknown,
		idempotencyKey: unknown,
	): Promise<SessionWorkspaceActionResult> {
		return this.withMutationLock(async () => {
			if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_PROMPT_CHARS) {
				return mutationError(400, "bad_request", `Body must include text (1-${MAX_PROMPT_CHARS} chars).`);
			}
			const guard = this.mutationGuard("prompt", id, { text }, expectedRevision, idempotencyKey);
			if (!guard.ok) return guard;
			if (guard.replay) return guard.replay;
			const found = await this.findSession(id);
			if (!found.ok) return found;
			const stale = checkRevision(found.session, expectedRevision);
			if (stale) return stale;
			if (!found.session.capabilities.prompt) {
				return mutationError(409, "prompt_not_ready", "The selected Herdr agent is not ready for a semantic prompt.");
			}
			this.beginMutation(guard);
			const result = await this.#client.promptAgent(found.agent.pane_id, text);
			if (!result.ok) return this.rejectMutation(guard, result);
			const success = this.actionSuccess("prompt", result.agent ?? found.agent);
			this.recordMutation(guard, success);
			return success;
		});
	}

	async focus(
		id: string,
		expectedRevision: unknown,
		idempotencyKey: unknown,
	): Promise<SessionWorkspaceActionResult> {
		return this.withMutationLock(async () => {
			const guard = this.mutationGuard("focus", id, {}, expectedRevision, idempotencyKey);
			if (!guard.ok) return guard;
			if (guard.replay) return guard.replay;
			const found = await this.findSession(id);
			if (!found.ok) return found;
			const stale = checkRevision(found.session, expectedRevision);
			if (stale) return stale;
			this.beginMutation(guard);
			const result = await this.#client.focusAgent(found.agent.pane_id);
			if (!result.ok) return this.rejectMutation(guard, result);
			const success = this.actionSuccess("focus", result.agent ?? found.agent);
			this.recordMutation(guard, success);
			return success;
		});
	}

	async resume(
		id: string,
		expectedRevision: unknown,
		idempotencyKey: unknown,
	): Promise<SessionWorkspaceActionResult> {
		return this.withMutationLock(async () => {
			const guard = this.mutationGuard("resume", id, {}, expectedRevision, idempotencyKey);
			if (!guard.ok) return guard;
			if (guard.replay) return guard.replay;
			const found = await this.findSession(id);
			if (!found.ok) return found;
			const stale = checkRevision(found.session, expectedRevision);
			if (stale) return stale;
			if (!found.session.capabilities.resume) {
				return mutationError(409, "resume_unsupported", "The selected Herdr agent has no supported native session reference.");
			}
			if (found.session.launchPending || !found.session.interactiveReady) {
				return mutationError(409, "resume_pending", "Herdr is still restoring this agent session; retry after it becomes interactive.");
			}
			// A listed Herdr agent already owns its native session. Resuming it is therefore
			// intentionally a no-op plus focus: it gives the phone the same "bring me back to
			// this session" semantic without inventing a second process-launch authority.
			this.beginMutation(guard);
			const result = await this.#client.focusAgent(found.agent.pane_id);
			if (!result.ok) return this.rejectMutation(guard, result);
			const success: Extract<SessionWorkspaceActionResult, { ok: true }> = {
				...this.actionSuccess("resume", result.agent ?? found.agent),
				alreadyActive: true,
			};
			this.recordMutation(guard, success);
			return success;
		});
	}

	async stream(id: string, res: ServerResponse, lines = 40): Promise<void> {
		let stopped = false;
		res.on("close", () => {
			stopped = true;
		});
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write("retry: 3000\n\n");

		let lastRevision = -1;
		let lastStatus: SessionWorkspaceStatus | undefined;
		let lastTail = "";
		let lastBeat = this.#now();
		while (!stopped && !res.writableEnded) {
			const detail = await this.detail(id, lines);
			if (!detail.ok) {
				writeEvent(res, "error", JSON.stringify({ code: detail.code, error: detail.error }));
				break;
			}
			const { session, tail } = detail.detail;
			if (session.revision !== lastRevision || session.status !== lastStatus) {
				writeEvent(res, "session", JSON.stringify({ session }));
				lastRevision = session.revision;
				lastStatus = session.status;
			}
			if (tail.text !== lastTail) {
				writeEvent(res, "tail", JSON.stringify({ tail }));
				lastTail = tail.text;
			}
			if (this.#now() - lastBeat >= STREAM_HEARTBEAT_MS) {
				res.write(": heartbeat\n\n");
				lastBeat = this.#now();
			}
			if (stopped || res.writableEnded) break;
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, STREAM_POLL_MS);
			res.once("close", resolve);
			await promise;
			clearTimeout(timer);
			res.removeListener("close", resolve);
		}
		if (!res.writableEnded) res.end();
	}

	private async findSession(id: string): Promise<
		| { readonly ok: true; readonly agent: HerdrAgentInfo; readonly session: SessionWorkspaceSession }
		| SessionWorkspaceError
	> {
		if (!/^s_[a-f0-9]{24}$/.test(id)) return mutationError(400, "bad_id", "Malformed session id.");
		const result = await this.#client.listAgents();
		if (!result.ok) return mutationError(503, "herdr_unavailable", result.error);
		const agent = result.agents.find((candidate) => sessionIdForAgent(candidate) === id);
		if (!agent) return mutationError(404, "not_found", `Unknown Herdr session: ${id}`);
		return { ok: true, agent, session: toSession(agent) };
	}

	private mutationGuard(
		action: "prompt" | "focus" | "resume",
		id: string,
		payload: Record<string, unknown>,
		expectedRevision: unknown,
		idempotencyKey: unknown,
	):
		| { readonly ok: true; readonly idempotencyKey: string; readonly fingerprint: string; readonly replay?: Extract<SessionWorkspaceActionResult, { ok: true }> }
		| SessionWorkspaceError {
		if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
			return mutationError(400, "idempotency_key_required", "X-Pi-Speak-Idempotency-Key is required (1-128 chars).");
		}
		if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
			return mutationError(400, "expected_revision_required", "A non-negative integer expectedRevision is required.");
		}
		const now = this.#now();
		for (const [key, stored] of this.#mutations) {
			if (stored.expiresAt <= now) this.#mutations.delete(key);
		}
		const fingerprint = JSON.stringify({ action, id, payload, expectedRevision });
		const stored = this.#mutations.get(idempotencyKey);
		if (stored && stored.expiresAt > now) {
			if (stored.fingerprint !== fingerprint) {
				return mutationError(409, "idempotency_conflict", "This idempotency key was already used with different mutation arguments.");
			}
			if (stored.status === "pending" || !stored.result) {
				return mutationError(503, "mutation_outcome_unknown", "A previous attempt with this idempotency key did not record an outcome; inspect Herdr before retrying.");
			}
			return { ok: true, idempotencyKey, fingerprint, replay: { ...stored.result, replayed: true } };
		}
		return { ok: true, idempotencyKey, fingerprint };
	}

	private actionSuccess(
		action: "prompt" | "focus" | "resume",
		agent: HerdrAgentInfo,
	): Extract<SessionWorkspaceActionResult, { ok: true }> {
		return {
			ok: true,
			action,
			session: toSession(agent),
			commandId: `${action}_${randomUUID()}`,
		};
	}

	private async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.#mutationChain;
		let release!: () => void;
		this.#mutationChain = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}

	private beginMutation(guard: { readonly idempotencyKey: string; readonly fingerprint: string }): void {
		this.#mutations.set(guard.idempotencyKey, {
			fingerprint: guard.fingerprint,
			status: "pending",
			expiresAt: this.#now() + IDEMPOTENCY_TTL_MS,
		});
		this.saveMutations();
	}

	private rejectMutation(
		guard: { readonly idempotencyKey: string },
		result: HerdrAgentActionResult,
	): SessionWorkspaceError {
		const failure = actionRejected(result);
		if (DEFINITE_ACTION_FAILURES[failure.code] === true) {
			this.#mutations.delete(guard.idempotencyKey);
			this.saveMutations();
		}
		return failure;
	}

	private recordMutation(
		guard: { readonly idempotencyKey: string; readonly fingerprint: string },
		result: Extract<SessionWorkspaceActionResult, { ok: true }>,
	): void {
		this.#mutations.set(guard.idempotencyKey, {
			fingerprint: guard.fingerprint,
			status: "completed",
			result,
			expiresAt: this.#now() + IDEMPOTENCY_TTL_MS,
		});
		this.saveMutations();
	}

	private loadMutations(): void {
		if (!existsSync(this.#mutationStorePath)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#mutationStorePath, "utf8"));
		} catch (error) {
			throw new Error(`Invalid session mutation store ${this.#mutationStorePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isMutationStore(parsed)) {
			throw new Error(`Invalid session mutation store ${this.#mutationStorePath}: expected version ${MUTATION_STORE_VERSION}.`);
		}
		const now = this.#now();
		for (const mutation of parsed.mutations) {
			if (mutation.expiresAt > now) this.#mutations.set(mutation.key, mutation);
		}
	}

	private saveMutations(): void {
		const now = this.#now();
		const mutations = [...this.#mutations.entries()]
			.filter(([, mutation]) => mutation.expiresAt > now)
			.map(([key, mutation]) => ({ ...mutation, key }));
		mkdirSync(dirname(this.#mutationStorePath), { recursive: true });
		const tempPath = `${this.#mutationStorePath}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify({ version: MUTATION_STORE_VERSION, mutations }, null, 2)}\n`, "utf8");
		renameSync(tempPath, this.#mutationStorePath);
	}
}

export function createSessionWorkspaceService(deps: SessionWorkspaceDeps = {}): SessionWorkspaceService {
	return new SessionWorkspaceService(deps);
}

export function sessionIdForAgent(agent: HerdrAgentInfo): string {
	const native = agent.agent_session;
	const identity = native
		? [native.source, native.agent, native.kind, native.value].join("\u0000")
		: [agent.workspace_id, agent.tab_id, agent.pane_id, agent.terminal_id].join("\u0000");
	return `s_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function toSession(agent: HerdrAgentInfo): SessionWorkspaceSession {
	const provider = agent.agent || agent.display_agent || "unknown";
	const nativeResume = resumeArgs(agent.agent_session);
	return {
		id: sessionIdForAgent(agent),
		displayName: agent.name || agent.title || agent.terminal_title_stripped || agent.display_agent || provider || agent.pane_id,
		provider,
		status: agent.agent_status,
		availability: "live",
		...(agent.cwd ? { cwd: agent.cwd } : {}),
		...(agent.foreground_cwd ? { foregroundCwd: agent.foreground_cwd } : {}),
		focused: agent.focused,
		interactiveReady: agent.interactive_ready === true,
		launchPending: agent.launch_pending === true,
		revision: agent.revision,
		stateChangeSeq: agent.state_change_seq ?? 0,
		...(agent.agent_session ? {
			nativeSession: {
				source: agent.agent_session.source,
				agent: agent.agent_session.agent,
				kind: agent.agent_session.kind,
			},
		} : {}),
		capabilities: {
			prompt: Boolean(agent.agent) && agent.launch_pending !== true,
			focus: true,
			resume: Boolean(nativeResume),
		},
	};
}

function resumeArgs(session: HerdrAgentSessionInfo | undefined): readonly string[] | undefined {
	if (!session) return undefined;
	const { source, agent, kind, value } = session;
	if (kind === "path" && agent !== "pi" && agent !== "omp") return undefined;
	switch (source) {
		case "herdr:claude": return kind === "id" ? ["--resume", value] : undefined;
		case "herdr:codex": return kind === "id" ? ["resume", value] : undefined;
		case "herdr:copilot": return kind === "id" ? [`--resume=${value}`] : undefined;
		case "herdr:devin": return kind === "id" ? ["--resume", value] : undefined;
		case "herdr:droid": return kind === "id" ? ["--resume", value] : undefined;
		case "herdr:kimi": return kind === "id" ? ["--session", value] : undefined;
		case "herdr:mastracode": return kind === "id" ? ["--thread", value] : undefined;
		case "herdr:pi": return ["--session", value];
		case "herdr:omp": return [`--resume=${value}`];
		case "herdr:hermes": return kind === "id" ? ["--resume", value] : undefined;
		case "herdr:opencode": return kind === "id" ? ["--session", value] : undefined;
		case "herdr:qodercli": return kind === "id" ? ["--resume", value] : undefined;
		case "herdr:kilo": return kind === "id" ? ["--session", value] : undefined;
		case "herdr:cursor": return kind === "id" ? ["--resume", value] : undefined;
		case "herdr:grok": return kind === "id" ? ["--resume", value] : undefined;
		default: return undefined;
	}
}

function checkRevision(session: SessionWorkspaceSession, expectedRevision: unknown): SessionWorkspaceError | undefined {
	if (session.revision === expectedRevision) return undefined;
	return mutationError(412, "revision_mismatch", `Session revision changed: expected ${expectedRevision}, current ${session.revision}.`);
}

function actionRejected(result: HerdrAgentActionResult): SessionWorkspaceError {
	const code = result.code || "action_rejected";
	const status = code === "target_not_found" || code === "agent_not_found" ? 404
		: code === "agent_not_ready" || code === "target_busy" ? 409
		: 502;
	return mutationError(status, code, result.error || result.message);
}

function mutationError(status: number, code: string, error: string): SessionWorkspaceError {
	return { ok: false, status, code, error };
}

function isMutationStore(value: unknown): value is MutationStoreFile {
	if (!isRecord(value) || value.version !== MUTATION_STORE_VERSION || !Array.isArray(value.mutations)) return false;
	return value.mutations.every((mutation) => isRecord(mutation)
		&& typeof mutation.key === "string"
		&& typeof mutation.fingerprint === "string"
		&& (mutation.status === "pending" || mutation.status === "completed")
		&& typeof mutation.expiresAt === "number"
		&& (mutation.status === "pending" || (isRecord(mutation.result)
			&& mutation.result.ok === true
			&& typeof mutation.result.action === "string"
			&& WORKSPACE_ACTIONS[mutation.result.action] === true
			&& typeof mutation.result.commandId === "string"
			&& isRecord(mutation.result.session)
			&& typeof mutation.result.session.id === "string"
			&& typeof mutation.result.session.revision === "number")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeEvent(res: ServerResponse, event: string, data: string): void {
	if (!res.writableEnded) res.write(`event: ${event}\ndata: ${data}\n\n`);
}
