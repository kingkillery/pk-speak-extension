import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentProvider, AgentPromptOptions, AgentResponseChunk } from "./agent-provider.js";
import { getErrorMessage } from "./agent-provider.js";
import { AsyncQueue } from "./async-queue.js";

type SpawnLike = (
	command: string,
	args: ReadonlyArray<string>,
	options: {
		stdio: ["pipe", "pipe", "pipe"];
		windowsHide: boolean;
		shell: boolean;
		env?: NodeJS.ProcessEnv;
		cwd?: string;
	},
) => ChildProcessWithoutNullStreams;

export type CodexApprovalMethod =
	| "item/commandExecution/requestApproval"
	| "item/fileChange/requestApproval"
	| "item/permissions/requestApproval";

export type CodexApprovalRequest = {
	method: CodexApprovalMethod;
	params: Record<string, unknown>;
};

export type CodexApprovalDecision = "accept" | "decline";

export type CodexAgentProviderOptions = {
	codexBin?: string;
	model?: string;
	cwd?: string;
	timeoutMs?: number;
	approvalPolicy?: string;
	sandbox?: string;
	spawnImpl?: SpawnLike;
	env?: NodeJS.ProcessEnv;
	/**
	 * Resolve a server-initiated approval request from the codex app-server.
	 * Called when the server emits item/commandExecution/requestApproval,
	 * item/fileChange/requestApproval, or item/permissions/requestApproval.
	 * If unset (or if the callback throws) the request is auto-declined so
	 * the agent does not hang waiting for a response.
	 */
	onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
};

type JsonRpcMessage = {
	id?: string | number;
	method?: string;
	params?: any;
	result?: any;
	error?: { code?: number; message?: string; data?: unknown };
	type?: string;
	[key: string]: unknown;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

type ActiveTurn = {
	threadId: string;
	turnId?: string;
	queue: AsyncQueue<AgentResponseChunk>;
	text: string;
};

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PI_SPEAK_CODEX_TIMEOUT_MS || "180000", 10);

function shouldUseShell(command: string) {
	return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

export class CodexAgentProvider implements AgentProvider {
	readonly name = "codex" as const;
	private readonly codexBin: string;
	private readonly model?: string;
	private readonly cwd: string;
	private readonly timeoutMs: number;
	private readonly approvalPolicy: string;
	private readonly sandbox: string;
	private readonly spawnImpl: SpawnLike;
	private readonly env?: NodeJS.ProcessEnv;
	private readonly onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
	private child?: ChildProcessWithoutNullStreams;
	private stdout?: Interface;
	private stderrText = "";
	private nextRequestId = 1;
	private initialized = false;
	private booting?: Promise<void>;
	private threadId?: string;
	private pendingRequests = new Map<string | number, PendingRequest>();
	private activeTurn?: ActiveTurn;

	constructor(options: CodexAgentProviderOptions = {}) {
		this.codexBin = options.codexBin || "codex";
		this.model = options.model;
		this.cwd = options.cwd || process.cwd();
		this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
		this.approvalPolicy = options.approvalPolicy || "never";
		this.sandbox = options.sandbox || "danger-full-access";
		this.spawnImpl = options.spawnImpl || (spawn as unknown as SpawnLike);
		this.env = options.env;
		this.onApprovalRequest = options.onApprovalRequest;
	}

	async start() {
		await this.ensureAppServer();
	}

	async stop() {
		for (const [, request] of this.pendingRequests) {
			clearTimeout(request.timeout);
			request.reject(new Error("Codex app-server stopped"));
		}
		this.pendingRequests.clear();
		this.activeTurn?.queue.fail(new Error("Codex app-server stopped"));
		this.activeTurn = undefined;
		this.stdout?.close();
		this.stdout = undefined;
		if (this.child && !this.child.killed) {
			try {
				this.child.kill();
			} catch {}
		}
		this.child = undefined;
		this.initialized = false;
		this.threadId = undefined;
	}

	async *sendPrompt(prompt: string, options: AgentPromptOptions = {}): AsyncIterable<AgentResponseChunk> {
		const attempt = { turnStarted: false };
		try {
			yield* this.sendViaAppServer(prompt, options, attempt);
		} catch (error) {
			if (attempt.turnStarted || this.activeTurn) throw error;
			yield* this.sendViaExec(prompt, options);
		}
	}

	private async *sendViaAppServer(
		prompt: string,
		options: AgentPromptOptions,
		attempt: { turnStarted: boolean },
	): AsyncIterable<AgentResponseChunk> {
		await this.ensureAppServer();
		const threadId = await this.ensureThread(options);

		if (this.activeTurn) {
			if (options.mode === "steer" && this.activeTurn.turnId) {
				await this.request("turn/steer", {
					threadId,
					expectedTurnId: this.activeTurn.turnId,
					input: [textInput(prompt)],
				}, options.timeoutMs);
				return;
			}
			throw new Error("Codex is already running a turn");
		}

		const activeTurn: ActiveTurn = {
			threadId,
			queue: new AsyncQueue<AgentResponseChunk>(),
			text: "",
		};
		this.activeTurn = activeTurn;
		attempt.turnStarted = true;
		let response: any;
		try {
			response = await this.request("turn/start", {
				threadId,
				input: [textInput(prompt)],
				model: options.model || this.model || null,
			}, options.timeoutMs);
		} catch (error) {
			if (this.activeTurn === activeTurn) this.activeTurn = undefined;
			throw error;
		}
		activeTurn.turnId = response?.turn?.id;

		try {
			for await (const chunk of activeTurn.queue) {
				yield chunk;
			}
		} finally {
			if (this.activeTurn === activeTurn) this.activeTurn = undefined;
		}
	}

	private async *sendViaExec(prompt: string, options: AgentPromptOptions): AsyncIterable<AgentResponseChunk> {
		const args = ["exec", "--json", "-C", options.cwd || this.cwd];
		const model = options.model || this.model;
		if (model) args.push("-m", model);
		args.push(prompt);

		const child = this.spawnImpl(this.codexBin, args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: shouldUseShell(this.codexBin),
			env: this.env,
			cwd: options.cwd || this.cwd,
		});
		child.stdin.end();
		const queue = new AsyncQueue<AgentResponseChunk>();
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			const message = parseJsonLine(line);
			if (message?.type === "error" || message?.error) {
				queue.fail(new Error(getErrorMessage(message.error || "Codex exec failed")));
				return;
			}
			const delta = extractTextDelta(message);
			if (delta) queue.push({ type: "text", text: delta });
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => queue.fail(error));
		child.on("exit", (code) => {
			rl.close();
			if (code === 0) queue.close();
			else queue.fail(new Error(stderr.trim() || `codex exec exited with code ${code ?? "unknown"}`));
		});

		for await (const chunk of queue) {
			yield chunk;
		}
	}

	private async ensureAppServer() {
		if (this.initialized && this.child && !this.child.killed) return;
		if (!this.booting) this.booting = this.bootAppServer();
		try {
			await this.booting;
		} finally {
			this.booting = undefined;
		}
	}

	private async bootAppServer() {
		this.child = this.spawnImpl(this.codexBin, ["app-server", "--listen", "stdio://"], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: shouldUseShell(this.codexBin),
			env: this.env,
			cwd: this.cwd,
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.stdout = createInterface({ input: this.child.stdout });
		this.stdout.on("line", (line) => this.handleAppServerLine(line));
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrText = `${this.stderrText}${chunk}`.slice(-4000);
		});
		this.child.on("error", (error) => this.handleAppServerExit(error));
		this.child.on("exit", (code) => this.handleAppServerExit(new Error(
			this.stderrText.trim() || `codex app-server exited with code ${code ?? "unknown"}`,
		)));

		try {
			await this.request("initialize", {
				clientInfo: {
					name: "pi-speak-pk",
					title: "Pi Speak",
					version: "0.2.1",
				},
				capabilities: {
					experimentalApi: true,
					optOutNotificationMethods: [],
				},
			}, 30_000);
			this.initialized = true;
		} catch (error) {
			this.disposeAppServerChild();
			throw error;
		}
	}

	private async ensureThread(options: AgentPromptOptions) {
		if (this.threadId) return this.threadId;
		const response = await this.request("thread/start", {
			cwd: options.cwd || this.cwd,
			model: options.model || this.model || null,
			approvalPolicy: this.approvalPolicy,
			sandbox: this.sandbox,
			developerInstructions: options.instructions || null,
			sessionStartSource: "startup",
		}, options.timeoutMs);
		const threadId = response?.thread?.id;
		if (typeof threadId !== "string" || !threadId) {
			throw new Error("Codex app-server did not return a thread id");
		}
		this.threadId = threadId;
		return threadId;
	}

	private request(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<any> {
		const child = this.child;
		if (!child || child.killed) throw new Error("Codex app-server is not running");
		const id = this.nextRequestId++;
		const payload = JSON.stringify({ id, method, params });
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Codex app-server request timed out: ${method}`));
			}, timeoutMs || this.timeoutMs);
			timeout.unref?.();
			this.pendingRequests.set(id, { resolve, reject, timeout });
			child.stdin.write(`${payload}\n`, (error) => {
				if (!error) return;
				const pending = this.pendingRequests.get(id);
				if (!pending) return;
				this.pendingRequests.delete(id);
				clearTimeout(pending.timeout);
				pending.reject(error);
			});
		});
	}

	private handleAppServerLine(line: string) {
		const message = parseJsonLine(line);
		if (!message) return;
		// Response to one of our outgoing requests
		if (message.id !== undefined && this.pendingRequests.has(message.id)) {
			const pending = this.pendingRequests.get(message.id)!;
			this.pendingRequests.delete(message.id);
			clearTimeout(pending.timeout);
			if (message.error) pending.reject(new Error(message.error.message || "Codex app-server request failed"));
			else pending.resolve(message.result);
			return;
		}
		// Server-initiated request (id + method, not a pending response)
		if (message.id !== undefined && typeof message.method === "string") {
			void this.handleServerRequest(message);
			return;
		}
		this.handleNotification(message);
	}

	private async handleServerRequest(message: JsonRpcMessage) {
		const id = message.id!;
		const method = message.method as string;

		if (isApprovalMethod(method)) {
			if (!this.onApprovalRequest) {
				// No handler installed — decline so the agent does not hang.
				this.writeResponse(id, { decision: "decline" });
				return;
			}
			let decision: CodexApprovalDecision = "decline";
			try {
				decision = await this.onApprovalRequest({
					method: method as CodexApprovalMethod,
					params: (message.params as Record<string, unknown>) || {},
				});
			} catch {
				decision = "decline";
			}
			this.writeResponse(id, formatApprovalResult(method, decision, message.params));
			return;
		}

		// Unknown server-initiated method — return JSON-RPC method-not-found.
		this.writeError(id, -32601, `Method not found: ${method}`);
	}

	private writeResponse(id: string | number, result: unknown) {
		const child = this.child;
		if (!child || child.killed) return;
		const payload = JSON.stringify({ id, result });
		child.stdin.write(`${payload}\n`);
	}

	private writeError(id: string | number, code: number, message: string) {
		const child = this.child;
		if (!child || child.killed) return;
		const payload = JSON.stringify({ id, error: { code, message } });
		child.stdin.write(`${payload}\n`);
	}

	private handleNotification(message: JsonRpcMessage) {
		if (!this.activeTurn) return;
		if (message.method === "item/agentMessage/delta") {
			const params = message.params || {};
			if (params.threadId !== this.activeTurn.threadId) return;
			if (this.activeTurn.turnId && params.turnId !== this.activeTurn.turnId) return;
			if (typeof params.delta !== "string" || !params.delta) return;
			this.activeTurn.text += params.delta;
			this.activeTurn.queue.push({ type: "text", text: params.delta });
			return;
		}
		if (message.method === "turn/completed") {
			const params = message.params || {};
			if (params.threadId !== this.activeTurn.threadId) return;
			if (this.activeTurn.turnId && params.turn?.id !== this.activeTurn.turnId) return;
			if (params.turn?.status === "failed") {
				this.activeTurn.queue.fail(new Error(params.turn?.error?.message || "Codex turn failed"));
			} else {
				this.activeTurn.queue.close();
			}
			return;
		}
		if (message.method === "error") {
			const params = message.params || {};
			if (params.threadId !== this.activeTurn.threadId) return;
			if (this.activeTurn.turnId && params.turnId !== this.activeTurn.turnId) return;
			this.activeTurn.queue.fail(new Error(params.error?.message || "Codex turn failed"));
		}
	}

	private handleAppServerExit(error: Error) {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingRequests.clear();
		this.activeTurn?.queue.fail(error);
		this.activeTurn = undefined;
		this.child = undefined;
		this.stdout?.close();
		this.stdout = undefined;
		this.initialized = false;
		this.threadId = undefined;
	}

	private disposeAppServerChild() {
		const child = this.child;
		this.child = undefined;
		this.stdout?.close();
		this.stdout = undefined;
		this.initialized = false;
		this.threadId = undefined;
		if (child && !child.killed) {
			try {
				child.kill();
			} catch {}
		}
	}
}

function isApprovalMethod(method: string): boolean {
	return (
		method === "item/commandExecution/requestApproval" ||
		method === "item/fileChange/requestApproval" ||
		method === "item/permissions/requestApproval"
	);
}

function formatApprovalResult(method: string, decision: CodexApprovalDecision, params: unknown): unknown {
	// item/permissions/requestApproval has a different accept payload —
	// it expects the granted scope and permissions echoed back.
	if (method === "item/permissions/requestApproval") {
		if (decision === "accept") {
			const requestedPermissions =
				params && typeof params === "object" && "permissions" in (params as Record<string, unknown>)
					? (params as { permissions?: unknown }).permissions
					: undefined;
			return { scope: "session", permissions: requestedPermissions ?? {} };
		}
		return { decision: "decline" };
	}
	return { decision };
}

function textInput(text: string) {
	return {
		type: "text",
		text,
		text_elements: [],
	};
}

function parseJsonLine(line: string): JsonRpcMessage | undefined {
	try {
		return JSON.parse(line) as JsonRpcMessage;
	} catch {
		return undefined;
	}
}

function extractTextDelta(message: JsonRpcMessage | undefined) {
	if (!message) return "";
	if (message.method === "item/agentMessage/delta" && typeof message.params?.delta === "string") {
		return message.params.delta;
	}
	if (message.type === "message_update") {
		const event = message.assistantMessageEvent as { type?: string; delta?: string } | undefined;
		if (event?.type === "text_delta" && typeof event.delta === "string") return event.delta;
	}
	if (message.type === "agent_message_delta" && typeof message.delta === "string") return message.delta;
	if (message.type === "response.output_text.delta" && typeof message.delta === "string") return message.delta;
	return "";
}
