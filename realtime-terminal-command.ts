import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveWindowsNpmShim } from "./agent-discovery.js";
import { safeSpawn } from "./spawn-shim.js";

export type RealtimeTerminalCommandSafety =
	| { action: "allow"; reason: string }
	| { action: "requires_confirmation"; reason: string };

export type RealtimeTerminalCommandPlan = RealtimeTerminalCommandSafety & {
	command: string;
	normalized: string;
	tokens: string[];
	family?: string;
	executable?: string;
	args?: string[];
	internal?: "get-content";
	executableKnown: boolean;
	secretInspection: boolean;
	timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const SHELL_CONTROL_PATTERN = /(?:\|\||&&|\$\(|[|;<>`\r\n])/;
const SECRET_INSPECTION_PATTERN = /\b(?:secret|token|api[_-]?key|apikey|password|credential|private[_-]?key|env|dotenv)\b|(?:^|[\\/])\.env(?:\.|$|[\\/])/i;
const SECRET_PATH_EXTENSION_PATTERN = /\.(pem|key|pfx|p12|jks|keystore)$/i;
const SECRET_PATH_FILENAME_PATTERN = /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i;
const RG_DENIED_OPTIONS = new Set(["--pre", "--pre-glob"]);

// Shared with the realtime read_workspace_file tool: a path that looks like it
// holds a credential or private key should never have its content narrated
// into a voice conversation or transcript. Broader/less precise than the
// terminal SECRET_INSPECTION_PATTERN check on purpose — this gates full file
// content, not just whether a command is allowed to run.
export function looksLikeSecretPath(targetPath: string): boolean {
	// path.basename() only splits on the host platform's separator, so a
	// Windows-style path (C:\Users\me\.ssh\id_rsa) running on a POSIX host
	// wouldn't get split at all and would slip past the filename/extension
	// checks below. Normalize both separators ourselves instead of relying on
	// the host OS to agree with the path's own style.
	const normalized = targetPath.replace(/\\/g, "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	return SECRET_INSPECTION_PATTERN.test(targetPath) || SECRET_PATH_EXTENSION_PATTERN.test(base) || SECRET_PATH_FILENAME_PATTERN.test(base);
}

function tokenizeCommand(command: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "\"" | "'" | undefined;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}

	if (quote) return undefined;
	if (current) tokens.push(current);
	return tokens;
}

function normalizeCommand(command: string) {
	return command.trim().replace(/\s+/g, " ");
}

function basePlan(
	command: string,
	action: RealtimeTerminalCommandSafety["action"],
	reason: string,
	tokens: string[] = [],
	extras: Partial<RealtimeTerminalCommandPlan> = {},
): RealtimeTerminalCommandPlan {
	const normalized = normalizeCommand(command);
	const secretInspection = SECRET_INSPECTION_PATTERN.test(normalized);
	return {
		action,
		reason: secretInspection && action === "allow" ? "secret-inspection" : reason,
		command,
		normalized,
		tokens,
		executableKnown: false,
		secretInspection,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		...extras,
	};
}

function npmExecutable() {
	return process.platform === "win32" ? resolveWindowsNpmShim("npm.cmd") || "npm.cmd" : "npm";
}

function commandName(token: string | undefined) {
	return path.basename(token || "").toLowerCase();
}

function hasOnlyFlags(args: string[]) {
	return args.every((arg) => arg.startsWith("-"));
}

function classifyAction(defaultAction: RealtimeTerminalCommandSafety["action"], secretInspection: boolean) {
	return secretInspection ? "requires_confirmation" : defaultAction;
}

export function buildRealtimeTerminalCommandPlan(command: string): RealtimeTerminalCommandPlan {
	const normalized = normalizeCommand(command);
	if (!normalized) {
		return basePlan(command, "requires_confirmation", "empty-command");
	}
	if (SHELL_CONTROL_PATTERN.test(command)) {
		return basePlan(command, "requires_confirmation", "shell-control-operator");
	}

	const tokens = tokenizeCommand(command);
	if (!tokens?.length) {
		return basePlan(command, "requires_confirmation", "parse-error", tokens || []);
	}

	const name = commandName(tokens[0]);
	const args = tokens.slice(1);
	const secretInspection = SECRET_INSPECTION_PATTERN.test(normalized);
	const readonlyAction = classifyAction("allow", secretInspection);
	const readonlyReason = secretInspection ? "secret-inspection" : "read-only-allowlist";

	if (name === "git") {
		if (args[0]?.toLowerCase() === "status" && hasOnlyFlags(args.slice(1))) {
			return basePlan(command, readonlyAction, readonlyReason, tokens, {
				family: "git status",
				executable: tokens[0],
				args,
				executableKnown: true,
			});
		}
		if (/^(commit|push|reset|checkout|clean|merge|rebase|tag)$/i.test(args[0] || "")) {
			return basePlan(command, "requires_confirmation", "mutating-command", tokens, {
				family: `git ${args[0].toLowerCase()}`,
				executable: tokens[0],
				args,
				executableKnown: true,
			});
		}
	}

	if (name === "npm" || name === "npm.cmd") {
		const npmArgs = args;
		const executable = npmExecutable();
		if (npmArgs[0]?.toLowerCase() === "test") {
			return basePlan(command, readonlyAction, readonlyReason, tokens, {
				family: "npm test",
				executable,
				args: npmArgs,
				executableKnown: true,
			});
		}
		if (npmArgs[0]?.toLowerCase() === "run" && npmArgs[1]?.toLowerCase() === "build" && npmArgs.length === 2) {
			return basePlan(command, readonlyAction, readonlyReason, tokens, {
				family: "npm run build",
				executable,
				args: npmArgs,
				executableKnown: true,
			});
		}
		if (/^(i|install|ci|add|remove|uninstall)$/i.test(npmArgs[0] || "")) {
			return basePlan(command, "requires_confirmation", "mutating-command", tokens, {
				family: `npm ${npmArgs[0].toLowerCase()}`,
				executable,
				args: npmArgs,
				executableKnown: true,
			});
		}
	}

	if (name === "rg" || name === "rg.exe") {
		const denied = args.find((arg) => RG_DENIED_OPTIONS.has(arg.split("=")[0]));
		if (denied) {
			return basePlan(command, "requires_confirmation", "not-on-read-only-allowlist", tokens);
		}
		return basePlan(command, readonlyAction, readonlyReason, tokens, {
			family: "rg",
			executable: tokens[0],
			args,
			executableKnown: true,
		});
	}

	if (name === "get-content") {
		if (args.some((arg) => arg.startsWith("-") && arg.toLowerCase() !== "-raw")) {
			return basePlan(command, "requires_confirmation", "not-on-read-only-allowlist", tokens);
		}
		return basePlan(command, readonlyAction, readonlyReason, tokens, {
			family: "Get-Content",
			args: args.filter((arg) => arg.toLowerCase() !== "-raw"),
			internal: "get-content",
			executableKnown: true,
		});
	}

	if (/^(rm|del|erase|rmdir|remove-item|ri|set-content|add-content|out-file|new-item|copy-item|move-item|mkdir|touch|start-process|invoke-expression|iex)$/i.test(name)) {
		return basePlan(command, "requires_confirmation", "mutating-command", tokens);
	}

	return basePlan(command, "requires_confirmation", "not-on-read-only-allowlist", tokens);
}

export function classifyRealtimeTerminalCommand(command: string): RealtimeTerminalCommandSafety {
	const plan = buildRealtimeTerminalCommandPlan(command);
	return { action: plan.action, reason: plan.reason };
}

function resolveWorkspacePath(cwd: string, requestedPath: string) {
	const resolved = path.resolve(cwd, requestedPath);
	const relative = path.relative(cwd, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Get-Content path is outside the active workspace: ${requestedPath}`);
	}
	return resolved;
}

async function runInternalGetContent(plan: RealtimeTerminalCommandPlan, cwd: string) {
	if (!plan.args?.length) {
		throw new Error("Get-Content requires at least one path.");
	}
	const chunks: string[] = [];
	for (const requestedPath of plan.args) {
		const resolved = resolveWorkspacePath(cwd, requestedPath);
		chunks.push(await readFile(resolved, "utf8"));
	}
	return { stdout: chunks.join("\n"), stderr: "", code: 0 };
}

export async function executeRealtimeTerminalCommandPlan(plan: RealtimeTerminalCommandPlan, cwd: string) {
	if (!plan.executableKnown) {
		return {
			ok: false,
			code: 127,
			stdout: "",
			stderr: `Command family is not registered for realtime execution: ${plan.tokens[0] || plan.command}`,
		};
	}
	if (plan.internal === "get-content") {
		try {
			const result = await runInternalGetContent(plan, cwd);
			return { ok: true, ...result };
		} catch (error) {
			// runInternalGetContent throws on path traversal / unreadable files;
			// return a structured error like the external-command branch instead
			// of letting the rejection escape to the caller.
			return { ok: false, code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	}
	if (!plan.executable) {
		return {
			ok: false,
			code: 127,
			stdout: "",
			stderr: "Registered command is missing an executable.",
		};
	}

	return await new Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>((resolve) => {
		const child = safeSpawn(plan.executable!, plan.args || [], {
			cwd,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			stderr += `\nCommand timed out after ${plan.timeoutMs}ms.`;
		}, plan.timeoutMs);
		timer.unref?.();

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, stdout, stderr: stderr || err.message, code: 127 });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ok: (code ?? 0) === 0, stdout, stderr, code: code ?? 0 });
		});
	});
}
