import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export const HERDR_TASK_STORAGE_VERSION = 1 as const;
export const HERDR_TASK_API_VERSION = 1 as const;

export type HubTaskState =
	| "blocked"
	| "ready"
	| "launching"
	| "running"
	| "awaiting_review"
	| "succeeded"
	| "failed"
	| "cancelled";

export type HubTaskReviewMode = "none" | "required";

export type HubWorkspace = {
	id: string;
	executorRoot: string;
};

export type HubLaneRef = {
	executorId: string;
	provider: "oh-my-pk";
	nativeSessionId: string;
};

export type HubTaskAttempt = {
	id: string;
	number: number;
	executorId: string;
	state: "launching" | "running" | "awaiting_review" | "succeeded" | "failed" | "cancelled";
	lane: HubLaneRef | null;
	localSessionDirectory: string | null;
	localSessionFile: string | null;
	launchRequestedAt: string;
	runningAt: string | null;
	executionCompletedAt: string | null;
	finishedAt: string | null;
	failureKind: "launch" | "execution" | "review" | "reconciliation" | null;
	reason: string | null;
};

export type HubReviewerVerdict = {
	id: string;
	attemptId: string;
	reviewerLane: HubLaneRef | null;
	result: "approved" | "changes_requested" | "inconclusive";
	summary: string;
	createdAt: string;
};

export type HubTask = {
	id: string;
	revision: number;
	title: string;
	prompt: string;
	workspaceId: string;
	workingDirectory: string;
	state: HubTaskState;
	dependsOn: string[];
	maxAttempts: number;
	attempts: HubTaskAttempt[];
	reviewMode: HubTaskReviewMode;
	reviewQuestion: string | null;
	verdicts: HubReviewerVerdict[];
	terminalReason: string | null;
	createdAt: string;
	updatedAt: string;
};

export type HubTaskCommandReceipt = {
	commandId: string;
	kind: "create_task";
	idempotencyKey: string;
	requestHash: string;
	status: "succeeded";
	taskId: string;
	createdAt: string;
	updatedAt: string;
};

export type HubTaskStore = {
	storageVersion: typeof HERDR_TASK_STORAGE_VERSION;
	serviceId: string;
	executorId: string;
	revision: number;
	workspaces: HubWorkspace[];
	tasks: HubTask[];
	commandReceipts: HubTaskCommandReceipt[];
};

export type CreateHubTaskInput = {
	title: string;
	prompt: string;
	workspaceId: string;
	workingDirectory?: string;
	dependsOn?: string[];
	maxAttempts?: number;
	reviewMode?: HubTaskReviewMode;
	reviewQuestion?: string | null;
	expectedRevision: number;
};

export class HubTaskValidationError extends Error {}
export class HubTaskConflictError extends Error {}
export class HubTaskRevisionError extends Error {}
export class HubTaskNotFoundError extends Error {}

function cloneStore(store: HubTaskStore): HubTaskStore {
	return structuredClone(store);
}

function canonicalCreateInput(input: CreateHubTaskInput) {
	return {
		title: input.title.trim(),
		prompt: input.prompt.trim(),
		workspaceId: input.workspaceId.trim(),
		workingDirectory: (input.workingDirectory || ".").trim() || ".",
		dependsOn: [...new Set(input.dependsOn || [])].sort(),
		maxAttempts: input.maxAttempts ?? 1,
		reviewMode: input.reviewMode ?? "none",
		reviewQuestion: input.reviewQuestion?.trim() || null,
		expectedRevision: input.expectedRevision,
	};
}


function validateCreateInput(input: CreateHubTaskInput) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new HubTaskValidationError("Task body must be an object.");
	}
	if (typeof input.title !== "string" || typeof input.prompt !== "string" || typeof input.workspaceId !== "string") {
		throw new HubTaskValidationError("title, prompt, and workspaceId must be strings.");
	}
	if (input.workingDirectory !== undefined && typeof input.workingDirectory !== "string") {
		throw new HubTaskValidationError("workingDirectory must be a string.");
	}
	if (input.dependsOn !== undefined && (
		!Array.isArray(input.dependsOn)
		|| input.dependsOn.some((dependencyId) => typeof dependencyId !== "string" || !dependencyId)
	)) {
		throw new HubTaskValidationError("dependsOn must be an array of task IDs.");
	}
	if (input.maxAttempts !== undefined && !Number.isInteger(input.maxAttempts)) {
		throw new HubTaskValidationError("maxAttempts must be an integer.");
	}
	if (input.reviewMode !== undefined && input.reviewMode !== "none" && input.reviewMode !== "required") {
		throw new HubTaskValidationError("reviewMode must be none or required.");
	}
	if (input.reviewQuestion !== undefined && input.reviewQuestion !== null && typeof input.reviewQuestion !== "string") {
		throw new HubTaskValidationError("reviewQuestion must be a string or null.");
	}
	if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
		throw new HubTaskValidationError("expectedRevision must be a non-negative integer.");
	}
}

function validateRelativeWorkingDirectory(value: string) {
	if (!value || value === ".") return;
	if (/^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
		throw new HubTaskValidationError("workingDirectory must be relative to the configured workspace root.");
	}
	const segments = value.replace(/\\/g, "/").split("/");
	if (segments.some((segment) => segment === "..")) {
		throw new HubTaskValidationError("workingDirectory must not traverse outside the configured workspace root.");
	}
}

function validateStore(value: unknown): asserts value is HubTaskStore {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr task store must be an object.");
	const store = value as Partial<HubTaskStore>;
	if (store.storageVersion !== HERDR_TASK_STORAGE_VERSION) {
		throw new Error(`Unsupported Herdr task storage version: ${String(store.storageVersion)}.`);
	}
	if (typeof store.serviceId !== "string" || !store.serviceId) throw new Error("Herdr task store is missing serviceId.");
	if (typeof store.executorId !== "string" || !store.executorId) throw new Error("Herdr task store is missing executorId.");
	if (!Number.isSafeInteger(store.revision) || (store.revision as number) < 0) throw new Error("Herdr task store has an invalid revision.");
	if (!Array.isArray(store.workspaces) || !Array.isArray(store.tasks) || !Array.isArray(store.commandReceipts)) {
		throw new Error("Herdr task store has invalid collections.");
	}
}

function isProcessAlive(pid: number) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

type RepositoryLockOwner = {
	pid: number;
	nonce?: string;
};

function parseRepositoryLockOwner(raw: string): RepositoryLockOwner | undefined {
	const value = raw.trim();
	if (/^\d+$/.test(value)) return { pid: Number.parseInt(value, 10) };
	try {
		const parsed = JSON.parse(value) as Partial<RepositoryLockOwner>;
		if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return undefined;
		if (typeof parsed.nonce !== "string" || !parsed.nonce) return undefined;
		return { pid: parsed.pid as number, nonce: parsed.nonce };
	} catch {
		return undefined;
	}
}

export class JsonHubTaskRepository {
	private lockFd: number | null = null;
	private lockNonce: string | null = null;
	private readonly lockPath: string;
	private readonly reclaimPath: string;

	constructor(readonly storePath: string) {
		this.lockPath = `${storePath}.lock`;
		this.reclaimPath = `${this.lockPath}.reclaim`;
		mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
		const reclaimLock = this.tryAcquireReclaimLock();
		if (!reclaimLock) {
			throw new HubTaskConflictError(`Herdr task store is already owned: ${this.lockPath}.`);
		}
		try {
			if (this.tryAcquireLock()) return;
			if (!this.removeStaleLock() || !this.tryAcquireLock()) {
				throw new HubTaskConflictError(`Herdr task store is already owned: ${this.lockPath}.`);
			}
		} finally {
			this.releaseReclaimLock(reclaimLock);
		}
	}

	load(workspaces: HubWorkspace[]): HubTaskStore {
		if (!existsSync(this.storePath)) {
			const initial: HubTaskStore = {
				storageVersion: HERDR_TASK_STORAGE_VERSION,
				serviceId: `service_${randomUUID()}`,
				executorId: `executor_${randomUUID()}`,
				revision: 0,
				workspaces: workspaces.map((workspace) => ({ ...workspace, executorRoot: resolve(workspace.executorRoot) })),
				tasks: [],
				commandReceipts: [],
			};
			this.write(initial);
			return initial;
		}
		const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as unknown;
		validateStore(parsed);
		return parsed;
	}

	commit(expectedRevision: number, next: HubTaskStore) {
		const current = JSON.parse(readFileSync(this.storePath, "utf8")) as unknown;
		validateStore(current);
		if (current.revision !== expectedRevision) {
			throw new HubTaskRevisionError(`Expected store revision ${expectedRevision}, found ${current.revision}.`);
		}
		this.write(next);
	}

	close() {
		if (this.lockFd === null) return;
		closeSync(this.lockFd);
		this.lockFd = null;
		const nonce = this.lockNonce;
		this.lockNonce = null;
		try {
			const owner = parseRepositoryLockOwner(readFileSync(this.lockPath, "utf8"));
			if (owner?.pid === process.pid && owner.nonce === nonce) rmSync(this.lockPath);
		} catch {}
	}

	private write(store: HubTaskStore) {
		const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(tempPath, this.storePath);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}

	private tryAcquireLock() {
		let fd: number | null = null;
		const nonce = randomUUID();
		try {
			fd = openSync(this.lockPath, "wx", 0o600);
			writeFileSync(fd, `${JSON.stringify({ pid: process.pid, nonce })}\n`, "utf8");
			this.lockFd = fd;
			this.lockNonce = nonce;
			return true;
		} catch {
			if (fd !== null) {
				try { closeSync(fd); } catch {}
				rmSync(this.lockPath, { force: true });
			}
			return false;
		}
	}

	private tryAcquireReclaimLock(): { fd: number; nonce: string } | undefined {
		let fd: number | null = null;
		const nonce = randomUUID();
		try {
			fd = openSync(this.reclaimPath, "wx", 0o600);
			writeFileSync(fd, `${JSON.stringify({ pid: process.pid, nonce })}\n`, "utf8");
			return { fd, nonce };
		} catch {
			if (fd !== null) {
				try { closeSync(fd); } catch {}
				rmSync(this.reclaimPath, { force: true });
			}
			return undefined;
		}
	}

	private releaseReclaimLock(lock: { fd: number; nonce: string }) {
		try { closeSync(lock.fd); } catch {}
		try {
			const owner = parseRepositoryLockOwner(readFileSync(this.reclaimPath, "utf8"));
			if (owner?.pid === process.pid && owner.nonce === lock.nonce) rmSync(this.reclaimPath);
		} catch {}
	}

	private removeStaleLock() {
		try {
			const snapshot = readFileSync(this.lockPath, "utf8");
			const owner = parseRepositoryLockOwner(snapshot);
			if (!owner || isProcessAlive(owner.pid)) return false;
			if (readFileSync(this.lockPath, "utf8") !== snapshot) return false;
			rmSync(this.lockPath);
			return true;
		} catch {
			return false;
		}
	}
}

export class HubTaskService {
	private store: HubTaskStore;

	constructor(
		private readonly repository: JsonHubTaskRepository,
		workspaces: HubWorkspace[],
	) {
		if (workspaces.length === 0) throw new HubTaskValidationError("At least one workspace mapping is required.");
		this.store = repository.load(workspaces);
	}

	getServiceInfo() {
		return {
			apiVersion: HERDR_TASK_API_VERSION,
			serviceId: this.store.serviceId,
			executorId: this.store.executorId,
			revision: this.store.revision,
			workspaces: this.store.workspaces.map(({ id }) => ({ id })),
		};
	}

	getSnapshot() {
		return cloneStore(this.store);
	}

	getTask(taskId: string) {
		const task = this.store.tasks.find((candidate) => candidate.id === taskId);
		if (!task) throw new HubTaskNotFoundError(`Unknown Hub task: ${taskId}.`);
		return structuredClone(task);
	}

	createTask(input: CreateHubTaskInput, idempotencyKey: string) {
		const key = idempotencyKey.trim();
		if (!key || key.length > 200) throw new HubTaskValidationError("A valid Idempotency-Key header is required.");
		validateCreateInput(input);
		const normalized = canonicalCreateInput(input);
		if (!normalized.title || normalized.title.length > 200) throw new HubTaskValidationError("title must contain 1-200 characters.");
		if (!normalized.prompt || normalized.prompt.length > 100_000) throw new HubTaskValidationError("prompt must contain 1-100000 characters.");
		if (!this.store.workspaces.some((workspace) => workspace.id === normalized.workspaceId)) {
			throw new HubTaskValidationError(`Unknown workspaceId: ${normalized.workspaceId}.`);
		}
		validateRelativeWorkingDirectory(normalized.workingDirectory);
		if (!Number.isInteger(normalized.maxAttempts) || normalized.maxAttempts < 1 || normalized.maxAttempts > 10) {
			throw new HubTaskValidationError("maxAttempts must be an integer from 1 to 10.");
		}
		if (normalized.reviewMode === "required" && !normalized.reviewQuestion) {
			throw new HubTaskValidationError("reviewQuestion is required when reviewMode is required.");
		}
		if (normalized.reviewMode === "none" && normalized.reviewQuestion) {
			throw new HubTaskValidationError("reviewQuestion requires reviewMode to be required.");
		}

		const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
		const prior = this.store.commandReceipts.find((receipt) => receipt.idempotencyKey === key);
		if (prior) {
			if (prior.requestHash !== requestHash) throw new HubTaskConflictError("Idempotency-Key was already used with different task arguments.");
			return { task: this.getTask(prior.taskId), created: false, commandId: prior.commandId };
		}
		if (input.expectedRevision !== this.store.revision) {
			throw new HubTaskRevisionError(`Expected store revision ${input.expectedRevision}, found ${this.store.revision}.`);
		}
		for (const dependencyId of normalized.dependsOn) {
			if (!this.store.tasks.some((task) => task.id === dependencyId)) {
				throw new HubTaskValidationError(`Unknown dependency task: ${dependencyId}.`);
			}
		}

		const now = new Date().toISOString();
		const task: HubTask = {
			id: `task_${randomUUID()}`,
			revision: 1,
			title: normalized.title,
			prompt: normalized.prompt,
			workspaceId: normalized.workspaceId,
			workingDirectory: normalized.workingDirectory,
			state: normalized.dependsOn.length === 0 ? "ready" : "blocked",
			dependsOn: normalized.dependsOn,
			maxAttempts: normalized.maxAttempts,
			attempts: [],
			reviewMode: normalized.reviewMode,
			reviewQuestion: normalized.reviewQuestion,
			verdicts: [],
			terminalReason: null,
			createdAt: now,
			updatedAt: now,
		};
		const receipt: HubTaskCommandReceipt = {
			commandId: `command_${randomUUID()}`,
			kind: "create_task",
			idempotencyKey: key,
			requestHash,
			status: "succeeded",
			taskId: task.id,
			createdAt: now,
			updatedAt: now,
		};
		const next = cloneStore(this.store);
		next.revision += 1;
		next.tasks.push(task);
		next.commandReceipts.push(receipt);
		this.repository.commit(this.store.revision, next);
		this.store = next;
		return { task: structuredClone(task), created: true, commandId: receipt.commandId };
	}

	close() {
		this.repository.close();
	}
}
