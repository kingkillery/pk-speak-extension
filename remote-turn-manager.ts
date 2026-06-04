export type RemoteTurnSource = "http-text" | "http-voice" | "telegram-text" | "telegram-voice";

export type TurnTimingSummary = {
	queueMs?: number;
	sttMs?: number;
	agentWaitMs?: number;
	agentRunMs?: number;
	ttsMs?: number;
	geminiLiveMs?: number;
	reducerMs?: number;
	totalMs?: number;
};

export type ProviderSummary = {
	agent?: string;
	stt?: string;
	tts?: string;
};

export type TurnProgressEvent = {
	ts: number;
	phase: "queued" | "recording" | "upload" | "stt" | "route" | "agent" | "tts" | "complete" | "error";
	message: string;
	elapsedMs?: number;
};

export type ConversationReducerSummary = {
	goal: string;
	actionItems: string[];
	constraints: string[];
	deferredReminders: string[];
	doNotDo: string[];
	unknowns: string[];
	discarded: string[];
	confidence: number;
	shouldDispatch: boolean;
	clarifyingQuestion: string | undefined;
	engine: "heuristic" | "gemini" | "openai";
};

export type ConversationExecutionPlan = {
	dispatch: boolean;
	backend: "pi" | "codex" | "claude" | "shell" | "memory" | "wiki" | "defer";
	reason: "dispatch-pi" | "dispatch-codex" | "dispatch-claude" | "dispatch-shell" | "dispatch-memory" | "dispatch-wiki" | "defer" | "clarify";
	confidence: number;
	rationale: string;
	actionForSeed?: string;
	signals?: string[];
	routeClass?: "fast" | "fast-plus-tools" | "slow-think";
	riskLevel?: "low" | "medium" | "high";
	latencyBudgetMs?: number;
	costTier?: "T0" | "T1" | "T2" | "T3";
	userAck?: string;
	userProgress?: string;
	escalationReason?: string;
};

export type RemoteTurnResult = {
	replyText: string;
	audioPath?: string;
	audioMimeType?: string;
	transcript?: string;
	busy?: boolean;
	timings?: TurnTimingSummary;
	providers?: ProviderSummary;
	reducer?: ConversationReducerSummary;
	execution?: ConversationExecutionPlan;
	warnings?: string[];
	progress?: TurnProgressEvent[];
};

export class BusyError extends Error {
	constructor(message = "Pi is busy, retry shortly.") {
		super(message);
		this.name = "BusyError";
	}
}

type QueuedTurn = {
	id: number;
	source: RemoteTurnSource;
	enqueuedAt: number;
	run: () => Promise<RemoteTurnResult>;
	resolve: (result: RemoteTurnResult) => void;
	reject: (error: Error) => void;
	timeoutId?: NodeJS.Timeout;
};

export type RemoteTurnManagerOptions = {
	maxQueued?: number;
	turnTimeoutMs?: number;
	onStateChange?: () => void;
};

export class RemoteTurnManager {
	private readonly maxQueued: number;
	private readonly turnTimeoutMs: number;
	private readonly onStateChange?: () => void;
	private readonly queue: QueuedTurn[] = [];
	private processing = false;
	private currentTurn?: {
		id: number;
		source: RemoteTurnSource;
		startedAt: number;
		enqueuedAt: number;
	};
	private nextId = 1;
	private completedTurns = 0;
	private lastStartedAt?: number;
	private lastCompletedAt?: number;
	private lastError?: string;

	constructor(options: RemoteTurnManagerOptions = {}) {
		this.maxQueued = options.maxQueued ?? 2;
		this.turnTimeoutMs = options.turnTimeoutMs ?? 180000;
		this.onStateChange = options.onStateChange;
	}

	getSnapshot() {
		return {
			processing: this.processing,
			activeSource: this.currentTurn?.source,
			activeTurnId: this.currentTurn?.id,
			activeForMs: this.currentTurn ? Date.now() - this.currentTurn.startedAt : 0,
			queued: this.queue.length,
			maxQueued: this.maxQueued,
			completedTurns: this.completedTurns,
			lastStartedAt: this.lastStartedAt,
			lastCompletedAt: this.lastCompletedAt,
			lastError: this.lastError,
		};
	}

	async enqueue(source: RemoteTurnSource, run: () => Promise<RemoteTurnResult>) {
		if (this.processing && this.queue.length >= this.maxQueued) {
			throw new BusyError();
		}

		const id = this.nextId++;
		return await new Promise<RemoteTurnResult>((resolve, reject) => {
			const queuedTurn: QueuedTurn = {
				id,
				source,
				enqueuedAt: Date.now(),
				run,
				resolve,
				reject,
			};
			queuedTurn.timeoutId = setTimeout(() => {
				const removed = this.removeQueuedTurn(id);
				if (removed) {
					reject(new Error("Remote turn timed out while waiting in queue."));
				}
			}, this.turnTimeoutMs);
			this.queue.push(queuedTurn);
			this.emitChange();
			void this.processQueue();
		});
	}

	cancelAll(reason: string) {
		const error = new Error(reason);
		for (const queuedTurn of this.queue.splice(0)) {
			if (queuedTurn.timeoutId) clearTimeout(queuedTurn.timeoutId);
			queuedTurn.reject(error);
		}
		if (this.currentTurn) {
			this.lastError = reason;
		}
		this.emitChange();
	}

	private removeQueuedTurn(id: number) {
		const index = this.queue.findIndex((turn) => turn.id === id);
		if (index < 0) return false;
		const [removed] = this.queue.splice(index, 1);
		if (removed.timeoutId) clearTimeout(removed.timeoutId);
		this.emitChange();
		return true;
	}

	private async processQueue() {
		if (this.processing) return;
		this.processing = true;
		this.emitChange();
		try {
			while (this.queue.length > 0) {
				const queuedTurn = this.queue.shift()!;
				if (queuedTurn.timeoutId) clearTimeout(queuedTurn.timeoutId);
				const startedAt = Date.now();
				this.currentTurn = {
					id: queuedTurn.id,
					source: queuedTurn.source,
					startedAt,
					enqueuedAt: queuedTurn.enqueuedAt,
				};
				this.lastStartedAt = startedAt;
				this.emitChange();
				try {
					const result = await queuedTurn.run();
					const queueMs = startedAt - queuedTurn.enqueuedAt;
					queuedTurn.resolve({
						...result,
						timings: {
							...result.timings,
							queueMs,
							totalMs: queueMs + (result.timings?.totalMs ?? 0),
						},
					});
					this.completedTurns += 1;
					this.lastError = undefined;
				} catch (error) {
					this.lastError = error instanceof Error ? error.message : String(error);
					queuedTurn.reject(error instanceof Error ? error : new Error(String(error)));
				} finally {
					this.lastCompletedAt = Date.now();
					this.currentTurn = undefined;
					this.emitChange();
				}
			}
		} finally {
			this.processing = false;
			this.emitChange();
		}
	}

	private emitChange() {
		this.onStateChange?.();
	}
}
