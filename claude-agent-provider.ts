import { spawn } from "node:child_process";
import type { AgentProvider, AgentPromptOptions } from "./agent-provider.js";

export class ClaudeAgentProvider implements AgentProvider {
	readonly name = "claude" as const;

	constructor(
		private readonly options: {
			claudeBin: string;
			cwd: string;
			model?: string;
			env?: NodeJS.ProcessEnv;
		},
	) {}

	async *sendPrompt(prompt: string, promptOptions: AgentPromptOptions = {}) {
		const cwd = promptOptions.cwd || this.options.cwd;
		const args = ["--print", "--output-format", "text"];
		const model = promptOptions.model || this.options.model;
		if (model) args.push("--model", model);
		const text = await runClaudeCli(this.options.claudeBin, args, {
			cwd,
			stdin: prompt,
			timeoutMs: promptOptions.timeoutMs,
			env: this.options.env,
			name: "claude",
		});
		if (text) yield { type: "text" as const, text };
	}
}

export class ClaudeResumeAgentProvider implements AgentProvider {
	readonly name = "claude" as const;

	constructor(
		private readonly options: {
			claudeBin: string;
			cwd: string;
			sessionId: string;
			model?: string;
			env?: NodeJS.ProcessEnv;
		},
	) {}

	async *sendPrompt(prompt: string, promptOptions: AgentPromptOptions = {}) {
		const cwd = promptOptions.cwd || this.options.cwd;
		const args = ["--print", "--output-format", "text", "--resume", this.options.sessionId];
		const model = promptOptions.model || this.options.model;
		if (model) args.push("--model", model);
		const text = await runClaudeCli(this.options.claudeBin, args, {
			cwd,
			stdin: prompt,
			timeoutMs: promptOptions.timeoutMs,
			env: this.options.env,
			name: "claude resume",
		});
		if (text) yield { type: "text" as const, text };
	}
}

function runClaudeCli(
	command: string,
	args: string[],
	options: { cwd: string; stdin: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; name: string },
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			windowsHide: true,
			shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeoutMs = options.timeoutMs || Number.parseInt(process.env.AGENT_TURN_TIMEOUT_MS || "45000", 10);
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			killProcessTree(child.pid);
			reject(new Error(`${options.name} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
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
				resolve(stdout.trim());
				return;
			}
			reject(new Error(stderr.trim() || `${options.name} exited with code ${code ?? "unknown"}`));
		});
		child.stdin?.end(options.stdin);
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
