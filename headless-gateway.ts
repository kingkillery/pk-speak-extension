#!/usr/bin/env node
import { ControlServer, type ControlActionResult, type ControlServerStatus } from "./control-server.js";
import { collectAgentResponse, resolveAgentProviderConfig, type AgentProvider } from "./agent-provider.js";
import type { RemoteTurnResult } from "./remote-turn-manager.js";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const state = {
	enabled: true,
	host: process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0",
	port: Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10),
	authToken: process.env.PI_SPEAK_HTTP_TOKEN || "",
};

const agentConfig = resolveAgentProviderConfig({
	...process.env,
	AGENT_PROVIDER: process.env.AGENT_PROVIDER || resolveDefaultAgentProvider(),
	CODEX_BIN: process.env.CODEX_BIN || resolveWindowsNpmShim("codex.cmd") || "codex",
	PI_BIN: process.env.PI_BIN || resolveWindowsNpmShim("pi.cmd") || "pi",
});
let provider: AgentProvider;
let fallbackProvider: AgentProvider | undefined;

function createAgentProvider(): AgentProvider {
	if (agentConfig.provider === "pi") {
		return new PiCliProvider(agentConfig.piBin, process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd());
	}
	fallbackProvider = new PiCliProvider(agentConfig.piBin, process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd());
	return new CodexExecProvider(agentConfig.codexBin, process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd(), agentConfig.model);
}

const routing = {
	currentSession: undefined as string | undefined,
	defaultTarget: undefined as string | undefined,
	availableTargets: [] as string[],
};

function status(): ControlServerStatus {
	return {
		agent: {
			provider: agentConfig.provider,
			configuredProvider: agentConfig.provider,
			model: agentConfig.model,
			capabilities: {
				textTurns: true,
				voiceTurns: false,
				audioReplies: false,
				routing: true,
				steering: false,
			},
		},
		speak: { enabled: false, configuredProvider: "auto", provider: "tray", rewriteEnabled: false, phase: "standby" },
		mono: { running: false, voiceInputActive: false, keepAliveSeconds: 0, status: "off" },
		phone: { enabled: false, consecutivePollFailures: 0 },
		remote: {
			enabled: true,
			host: state.host,
			port: state.port,
			authRequired: !!state.authToken,
			defaultTarget: routing.defaultTarget,
			currentSession: routing.currentSession,
			availableTargets: routing.availableTargets,
		},
	};
}

async function runTextTurn(text: string, cwd?: string): Promise<RemoteTurnResult> {
	const prompt = text.trim();
	if (!prompt) return { replyText: "Send a message first." };
	const options = {
		model: agentConfig.model,
		cwd: cwd || process.env.AGENT_CWD || process.env.AGENT_WORKSPACE || process.cwd(),
	};
	let activeProvider = provider;
	let warnings: string[] | undefined;
	let replyText: string;
	try {
		replyText = await collectAgentResponse(activeProvider, prompt, options);
	} catch (error) {
		if (!fallbackProvider) throw error;
		warnings = [`Primary ${activeProvider.name} backend failed; used ${fallbackProvider.name} fallback.`];
		activeProvider = fallbackProvider;
		replyText = await collectAgentResponse(activeProvider, prompt, options);
	}
	return {
		replyText: replyText || "The agent completed the turn without returning text.",
		transcript: prompt,
		providers: { agent: activeProvider.name },
		warnings,
	};
}

function unavailableVoiceTurn(): RemoteTurnResult {
	return {
		replyText: "Voice turns need the full Pi Speak extension runtime. Text turns are available from the tray gateway.",
		warnings: ["headless-tray-gateway"],
	};
}

const ok = (message: string): ControlActionResult => ({ ok: true, message });
let server: ControlServer;

class PiCliProvider implements AgentProvider {
	readonly name = "pi" as const;
	constructor(private readonly piBin: string, private readonly cwd: string) {}

	async *sendPrompt(prompt: string, options: { cwd?: string } = {}) {
		const command = resolveWindowsPiNodeCommand(this.piBin) || { file: this.piBin, args: [] };
		const text = await runCli(command.file, [...command.args, "-p", "--no-tools", "--no-context-files", "--no-skills", "--no-extensions", "--no-session", prompt], {
			cwd: options.cwd || this.cwd,
			name: "pi",
			shell: command.shell,
		});
		if (text) yield { type: "text" as const, text };
	}
}

class CodexExecProvider implements AgentProvider {
	readonly name = "codex" as const;
	constructor(private readonly codexBin: string, private readonly cwd: string, private readonly model?: string) {}

	async *sendPrompt(prompt: string, options: { cwd?: string; model?: string } = {}) {
		const cwd = options.cwd || this.cwd;
		const args = ["exec", "--skip-git-repo-check", "-C", cwd, "--color", "never"];
		const model = options.model || this.model;
		if (model) args.push("-m", model);
		args.push("-");
		const text = await runCli(this.codexBin, args, { cwd, name: "codex exec", stdin: prompt });
		if (text) yield { type: "text" as const, text };
	}
}

provider = createAgentProvider();

server = new ControlServer({
	state,
	onStateChange: (patch) => Object.assign(state, patch),
	getStatus: status,
	getDiagnostics: () => ({
		status: status(),
		lastErrors: {},
		recentTimings: {},
		queue: { processing: false, queued: 0, maxQueued: 0, completedTurns: 0 },
	}),
	getRoutingStatus: () => ({ ...routing }),
	setRoutingTarget: (target) => {
		routing.defaultTarget = target?.trim() || undefined;
		return ok(routing.defaultTarget ? `Route target set to ${routing.defaultTarget}.` : "Route target cleared.");
	},
	onMonoAction: (action) => ok(`Mono ${action} is unavailable in tray gateway mode.`),
	onSpeakAction: (action) => ok(`Speak ${action} is unavailable in tray gateway mode.`),
	onPhoneAction: (action) => ok(`Phone ${action} is unavailable in tray gateway mode.`),
	onTextTurn: async (text, _includeAudio, _target, cwd) => runTextTurn(text, cwd),
	onVoiceTurn: async () => unavailableVoiceTurn(),
});

Promise.resolve(provider.start?.())
	.then(() => server.start())
	.then((runtime) => {
		console.log(`Pi Speak headless gateway listening on ${runtime.host}:${runtime.port} with ${provider.name}`);
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exit(1);
	});

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function shutdown() {
	Promise.resolve(provider.stop?.())
		.catch(() => {})
		.then(() => server.stop())
		.catch(() => {})
		.finally(() => process.exit(0));
}

function resolveWindowsNpmShim(name: string): string | undefined {
	if (process.platform !== "win32") return undefined;
	const appData = process.env.APPDATA;
	if (!appData) return undefined;
	const candidate = join(appData, "npm", name);
	return existsSync(candidate) ? candidate : undefined;
}

function buildAgentEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (!env.OPENAI_API_KEY && env.PI_SPEAK_OPENAI_KEY) {
		env.OPENAI_API_KEY = env.PI_SPEAK_OPENAI_KEY;
	}
	return env;
}

function runCli(command: string, args: string[], options: { cwd: string; name: string; stdin?: string; shell?: boolean }): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: buildAgentEnv(),
			windowsHide: true,
			shell: options.shell ?? process.platform === "win32",
			stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeoutMs = Number.parseInt(process.env.AGENT_TURN_TIMEOUT_MS || "45000", 10);
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			killProcessTree(child.pid);
			reject(new Error(`${options.name} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		if (!child.stdout || !child.stderr) {
			clearTimeout(timeout);
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
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
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

function killProcessTree(pid?: number) {
	if (!pid) return;
	if (process.platform === "win32") {
		spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
}

function resolveWindowsPiNodeCommand(piBin: string): { file: string; args: string[]; shell?: boolean } | undefined {
	if (process.platform !== "win32") return undefined;
	const appData = process.env.APPDATA;
	if (!appData) return undefined;
	const cli = join(appData, "npm", "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");
	if (!existsSync(cli)) return undefined;
	const normalized = piBin.toLowerCase().replace(/\\/g, "/");
	if (!normalized.endsWith("/pi.cmd") && !normalized.endsWith("/pi")) return undefined;
	return { file: process.execPath, args: [cli], shell: false };
}

function resolveDefaultAgentProvider(): "pi" | "codex" {
	if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return "codex";
	const codexBin = process.env.CODEX_BIN || resolveWindowsNpmShim("codex.cmd") || "codex";
	try {
		const output = execFileSync(codexBin, ["login", "status"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
			shell: process.platform === "win32",
			timeout: 5000,
		});
		return /logged in|authenticated/i.test(output) && !/not logged in/i.test(output) ? "codex" : "pi";
	} catch {
		return "pi";
	}
}
