import { spawn } from "node:child_process";
import { safeSpawn } from "./spawn-shim.js";
import type { AgentProvider, AgentProviderConfig, AgentProviderName, AgentPromptOptions } from "./agent-provider.js";
import { normalizeRunnableAgentProviderName, type RunnableAgentProviderName } from "./agent-provider-registry.js";
import { ClaudeAgentProvider, ClaudeResumeAgentProvider } from "./claude-agent-provider.js";
import { CodexAgentProvider } from "./codex-agent-provider.js";
import { resolveWindowsPiNodeCommand } from "./agent-discovery.js";
import { runGeminiLiveTurn, runGeminiTextTurn } from "./gemini-live-turn.js";
import type { ResumedGatewayTarget } from "./headless-gateway-routing.js";

// Whether ompk invocations should pass --no-extensions. Default OFF: the original
// npm auto-update failure (pi-speak-pk@latest) was fixed by removing that package
// from pi settings, so blanket-disabling extensions would needlessly strip local
// extension capabilities a session may rely on (review M2). Opt back in with
// PI_SPEAK_OMPK_NO_EXTENSIONS=1 if a broken extension resurfaces. The old
// PI_SPEAK_OMP_NO_EXTENSIONS name is still honored. Applied to BOTH fresh and
// resume ompk providers so behavior is consistent (review M1).
export function ompExtensionArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = (env.PI_SPEAK_OMPK_NO_EXTENSIONS || env.PI_SPEAK_OMP_NO_EXTENSIONS || "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" ? ["--no-extensions"] : [];
}

export type AgentProviderFactoryOptions = {
	config: AgentProviderConfig;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
};

export type InitialAgentProviders = {
	provider: AgentProvider;
	fallbackProvider?: AgentProvider;
};

export type TurnAgentProviderDecision = {
	provider: AgentProvider;
	stopAfterTurn: boolean;
	source: "shared" | "fallback" | "fresh" | "resume";
};

export type TurnAgentProviderInput = AgentProviderFactoryOptions & {
	backend: RunnableAgentProviderName;
	target?: ResumedGatewayTarget;
	preferShared?: boolean;
	sharedProvider?: AgentProvider;
	fallbackProvider?: AgentProvider;
	ompSessionPath?: string;
};

export function createInitialAgentProviders(options: AgentProviderFactoryOptions): InitialAgentProviders {
	const providerName = options.config.provider;
	const cwd = resolveAgentWorkspace(options);
	if (providerName === "elevenlabs") {
		return createCodingAgentProviders(options, cwd);
	}
	if (providerName === "gemini" || providerName === "gemini-live") {
		return { provider: new GeminiProvider(providerName) };
	}
	if (providerName === "claude") {
		return { provider: createClaudeProvider(options, cwd) };
	}
	if (providerName === "oh-my-pk") {
		return { provider: createOmpAgentProvider(options.config.ompBin, cwd, options.env) };
	}
	if (providerName === "pi") {
		return { provider: createPiProvider(options, cwd) };
	}
	return createCodexProviders(options, cwd);
}

export function createTurnAgentProvider(input: TurnAgentProviderInput): TurnAgentProviderDecision {
	if (input.ompSessionPath && input.backend === "oh-my-pk") {
		return {
			provider: createOmpResumeProvider(input.config.ompBin, input.cwd || resolveAgentWorkspace(input), input.ompSessionPath, input.env),
			stopAfterTurn: true,
			source: "resume",
		};
	}
	if (input.target && input.backend === "codex") {
		return {
			provider: new CodexResumeProvider(input.config.codexBin, input.cwd || resolveAgentWorkspace(input), input.target.sessionId, input.config.model, input.env),
			stopAfterTurn: true,
			source: "resume",
		};
	}
	if (input.target && input.backend === "claude") {
		return {
			provider: new ClaudeResumeAgentProvider({
				claudeBin: input.config.claudeBin,
				cwd: input.cwd || resolveAgentWorkspace(input),
				sessionId: input.target.sessionId,
				model: input.config.model,
				env: input.env,
			}),
			stopAfterTurn: true,
			source: "resume",
		};
	}
	if (input.preferShared && input.sharedProvider?.name === input.backend) {
		return { provider: input.sharedProvider, stopAfterTurn: false, source: "shared" };
	}
	if (input.preferShared && input.fallbackProvider?.name === input.backend) {
		return { provider: input.fallbackProvider, stopAfterTurn: false, source: "fallback" };
	}
	return {
		provider: createProviderForBackend(input, input.backend, input.cwd || resolveAgentWorkspace(input)),
		stopAfterTurn: true,
		source: "fresh",
	};
}

export function resolveAgentWorkspace(options: AgentProviderFactoryOptions): string {
	const env = options.env || process.env;
	return env.AGENT_CWD || env.AGENT_WORKSPACE || options.cwd || process.cwd();
}

function createCodingAgentProviders(options: AgentProviderFactoryOptions, cwd: string): InitialAgentProviders {
	const env = options.env || process.env;
	const backend = normalizeRunnableAgentProviderName(env.PI_SPEAK_AGENT_BACKEND || env.PI_SPEAK_CODING_AGENT) || "codex";
	if (backend === "pi") return { provider: createPiProvider(options, cwd) };
	if (backend === "claude") return { provider: createClaudeProvider(options, cwd) };
	if (backend === "oh-my-pk") return { provider: createOmpAgentProvider(options.config.ompBin, cwd, options.env) };
	return createCodexProviders(options, cwd);
}

function createCodexProviders(options: AgentProviderFactoryOptions, cwd: string): InitialAgentProviders {
	return {
		provider: createCodexProvider(options, cwd),
		fallbackProvider: createPiProvider(options, cwd),
	};
}

function createProviderForBackend(options: AgentProviderFactoryOptions, backend: RunnableAgentProviderName, cwd: string): AgentProvider {
	if (backend === "pi") return createPiProvider(options, cwd);
	if (backend === "claude") return createClaudeProvider(options, cwd);
	if (backend === "oh-my-pk") return createOmpAgentProvider(options.config.ompBin, cwd, options.env);
	return createCodexProvider(options, cwd);
}

export function createOmpAgentProvider(ompBin: string, cwd: string, env?: NodeJS.ProcessEnv): AgentProvider {
	return new OmpCliProvider(ompBin, cwd, env);
}

export function createOmpResumeProvider(ompBin: string, cwd: string, sessionPath: string, env?: NodeJS.ProcessEnv): AgentProvider {
	return new OmpResumeProvider(ompBin, cwd, sessionPath, env);
}

function createPiProvider(options: AgentProviderFactoryOptions, cwd: string): AgentProvider {
	return new PiCliProvider(options.config.piBin, cwd, options.env);
}

function createClaudeProvider(options: AgentProviderFactoryOptions, cwd: string): AgentProvider {
	return new ClaudeAgentProvider({
		claudeBin: options.config.claudeBin,
		cwd,
		model: options.config.model,
		env: options.env,
	});
}

function createCodexProvider(options: AgentProviderFactoryOptions, cwd: string): AgentProvider {
	return new CodexAgentProvider({
		codexBin: options.config.codexBin,
		cwd,
		model: options.config.model,
		approvalPolicy: options.config.approvalPolicy,
		sandbox: options.config.sandbox,
		env: options.env,
	});
}

class PiCliProvider implements AgentProvider {
	readonly name = "pi" as const;
	constructor(private readonly piBin: string, private readonly cwd: string, private readonly env?: NodeJS.ProcessEnv) {}

	async *sendPrompt(prompt: string, options: AgentPromptOptions = {}) {
		const command = resolveWindowsPiNodeCommand(this.piBin) || { file: this.piBin, args: [] };
		const text = await runCli(command.file, [...command.args, "-p", "--no-tools", "--no-context-files", "--no-skills", "--no-extensions", "--no-session", prompt], {
			cwd: options.cwd || this.cwd,
			name: "pi",
			env: this.env,
		});
		if (text) yield { type: "text" as const, text };
	}
}

const MAX_PENDING_OMP_CLI_TURNS = 3;
let pendingOmpCliTurns = 0;
let ompCliTurnTail: Promise<void> = Promise.resolve();

async function runOmpCli(
	command: string,
	args: string[],
	options: { cwd: string; name: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
	if (pendingOmpCliTurns >= MAX_PENDING_OMP_CLI_TURNS) {
		throw new Error("oh-my-pk is busy; retry shortly");
	}
	pendingOmpCliTurns += 1;
	const execute = () => runCli(command, args, options);
	const turn = ompCliTurnTail.then(execute, execute);
	ompCliTurnTail = turn.then(() => undefined, () => undefined);
	try {
		return await turn;
	} finally {
		pendingOmpCliTurns -= 1;
	}
}

class OmpCliProvider implements AgentProvider {
	readonly name = "oh-my-pk" as const;
	constructor(private readonly ompBin: string, private readonly cwd: string, private readonly env?: NodeJS.ProcessEnv) {}

	async *sendPrompt(prompt: string, options: AgentPromptOptions = {}) {
		const cwd = options.cwd || this.cwd;
		const args = ["-p", "--cwd", cwd, ...ompExtensionArgs(this.env)];
		const model = options.model?.trim();
		if (model) args.push("--model", model);
		args.push("--auto-approve", prompt);
		const text = await runOmpCli(this.ompBin, args, {
			cwd,
			name: "oh-my-pk",
			env: this.env,
		});
		if (text) yield { type: "text" as const, text };
	}
}

class OmpResumeProvider implements AgentProvider {
	readonly name = "oh-my-pk" as const;
	constructor(
		private readonly ompBin: string,
		private readonly cwd: string,
		private readonly sessionPath: string,
		private readonly env?: NodeJS.ProcessEnv,
	) {}

	async *sendPrompt(prompt: string, options: AgentPromptOptions = {}) {
		const cwd = options.cwd || this.cwd;
		const args = ["-p", "--cwd", cwd, ...ompExtensionArgs(this.env), "--resume", this.sessionPath];
		const model = options.model?.trim();
		if (model) args.push("--model", model);
		args.push("--auto-approve", prompt);
		const text = await runOmpCli(this.ompBin, args, {
			cwd,
			name: "oh-my-pk-resume",
			env: this.env,
		});
		if (text) yield { type: "text" as const, text };
	}
}

class CodexResumeProvider implements AgentProvider {
	readonly name = "codex" as const;
	constructor(
		private readonly codexBin: string,
		private readonly cwd: string,
		private readonly sessionId: string,
		private readonly model?: string,
		private readonly env?: NodeJS.ProcessEnv,
	) {}

	async *sendPrompt(prompt: string, options: AgentPromptOptions = {}) {
		const cwd = options.cwd || this.cwd;
		const args = ["exec", "resume", "--skip-git-repo-check"];
		const model = options.model || this.model;
		if (model) args.push("-m", model);
		args.push(this.sessionId, "-");
		const text = await runCli(this.codexBin, args, { cwd, name: "codex resume", stdin: prompt, env: this.env });
		if (text) yield { type: "text" as const, text };
	}
}

class GeminiProvider implements AgentProvider {
	readonly name: Extract<AgentProviderName, "gemini" | "gemini-live">;
	constructor(name: Extract<AgentProviderName, "gemini" | "gemini-live">) {
		this.name = name;
	}

	async *sendPrompt(prompt: string) {
		const result = this.name === "gemini-live"
			? await runGeminiLiveTurn(prompt)
			: await runGeminiTextTurn(prompt);
		if (result.replyText) yield { type: "text" as const, text: result.replyText };
	}
}

function buildAgentEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const merged = { ...process.env, ...env };
	if (!merged.OPENAI_API_KEY && merged.PI_SPEAK_OPENAI_KEY) {
		merged.OPENAI_API_KEY = merged.PI_SPEAK_OPENAI_KEY;
	}
	return merged;
}

const CLI_TERMINATION_GRACE_MS = 2_000;
const CLI_FORCE_KILL_WAIT_MS = 2_000;

function runCli(command: string, args: string[], options: { cwd: string; name: string; stdin?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = safeSpawn(command, args, {
			cwd: options.cwd,
			env: buildAgentEnv(options.env),
			windowsHide: true,
			stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let forceKillTimeout: NodeJS.Timeout | undefined;
		let terminationDeadline: NodeJS.Timeout | undefined;
		const timeoutMs = Number.parseInt(options.env?.AGENT_TURN_TIMEOUT_MS || process.env.AGENT_TURN_TIMEOUT_MS || "45000", 10);
		const timeoutError = new Error(`${options.name} timed out after ${timeoutMs}ms`);
		const clearRunTimers = () => {
			clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			if (terminationDeadline) clearTimeout(terminationDeadline);
		};
		const timeout = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			killProcessTree(child.pid);
			forceKillTimeout = setTimeout(() => {
				if (settled) return;
				killProcessTree(child.pid, true);
			}, CLI_TERMINATION_GRACE_MS);
			terminationDeadline = setTimeout(() => {
				if (settled) return;
				settled = true;
				clearRunTimers();
				reject(timeoutError);
			}, CLI_TERMINATION_GRACE_MS + CLI_FORCE_KILL_WAIT_MS);
		}, timeoutMs);
		if (!child.stdout || !child.stderr) {
			settled = true;
			clearRunTimers();
			reject(new Error(`${options.name} did not expose output streams`));
			return;
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled || timedOut) return;
			settled = true;
			clearRunTimers();
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearRunTimers();
			if (timedOut) {
				reject(timeoutError);
				return;
			}
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(new Error(stderr.trim() || `${options.name} exited with code ${code ?? "unknown"}`));
		});
		if (options.stdin && child.stdin) {
			child.stdin.end(options.stdin);
		}
	});
}

function killProcessTree(pid?: number, force = false) {
	if (!pid) return;
	if (process.platform === "win32") {
		const args = ["/PID", String(pid), "/T"];
		if (force) args.push("/F");
		spawn("taskkill.exe", args, { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(pid, force ? "SIGKILL" : "SIGTERM");
	} catch {}
}
