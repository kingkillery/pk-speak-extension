import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HerdrCommandResult = {
	readonly ok: boolean;
	readonly message: string;
	readonly stdout?: string;
	readonly error?: string;
	readonly code?: string;
};

export type HerdrSnapshot = {
	readonly available: boolean;
	readonly executable: string;
	readonly error?: string;
	readonly workspaces: readonly unknown[];
	readonly panes: readonly unknown[];
	readonly agents: readonly unknown[];
};

export type HerdrPaneReadResult = HerdrCommandResult & {
	readonly paneId?: string;
	readonly text?: string;
};

export type HerdrPaneSendPayload = {
	readonly paneId?: string;
	readonly text?: string;
	readonly submit?: boolean;
};

export type HerdrAgentSendPayload = {
	readonly agentId?: string;
	readonly text?: string;
};

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type HerdrAgentSessionInfo = {
	readonly source: string;
	readonly agent: string;
	readonly kind: "id" | "path";
	readonly value: string;
};

export type HerdrAgentInfo = {
	readonly terminal_id: string;
	readonly name?: string;
	readonly agent?: string;
	readonly title?: string;
	readonly terminal_title?: string;
	readonly terminal_title_stripped?: string;
	readonly display_agent?: string;
	readonly agent_status: HerdrAgentStatus;
	readonly screen_detection_skipped?: boolean;
	readonly state_labels?: Record<string, string>;
	readonly tokens?: Record<string, string>;
	readonly agent_session?: HerdrAgentSessionInfo;
	readonly workspace_id: string;
	readonly tab_id: string;
	readonly pane_id: string;
	readonly focused: boolean;
	readonly launch_pending?: boolean;
	readonly interactive_ready?: boolean;
	readonly state_change_seq?: number;
	readonly cwd?: string;
	readonly foreground_cwd?: string;
	readonly revision: number;
};

export type HerdrAgentListResult =
	| { readonly ok: true; readonly executable: string; readonly agents: readonly HerdrAgentInfo[] }
	| { readonly ok: false; readonly executable: string; readonly code: string; readonly error: string };

export type HerdrAgentReadResult = HerdrCommandResult & {
	readonly target?: string;
	readonly text?: string;
	readonly truncated?: boolean;
	readonly revision?: number;
};

export type HerdrAgentActionResult = HerdrCommandResult & {
	readonly agent?: HerdrAgentInfo;
};

export type HerdrAgentStartResult = HerdrAgentActionResult & {
	readonly argv?: readonly string[];
};

const HERDR_COMMAND_TIMEOUT_MS = 5000;
const HERDR_READ_TIMEOUT_MS = 5000;
const HERDR_SEND_TIMEOUT_MS = 10000;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEV_HERDR_EXECUTABLE = process.platform === "win32" ? "herdr.exe" : "herdr";
const DEV_HERDR_EXECUTABLES = [
	resolve(MODULE_DIR, "..", "..", "pk-herd", "target", "release", DEV_HERDR_EXECUTABLE),
	resolve(MODULE_DIR, "..", "..", "pk-herd", "target", "debug", DEV_HERDR_EXECUTABLE),
];

export function getHerdrExecutable(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SPEAK_HERDR_BIN?.trim()
		|| env.HERDR_BIN_PATH?.trim()
		|| DEV_HERDR_EXECUTABLES.find((candidate) => existsSync(candidate))
		|| "herdr";
}

export async function buildHerdrSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<HerdrSnapshot> {
	const executable = getHerdrExecutable(env);
	const workspaces = await runHerdrJsonArray(executable, ["workspace", "list"], ["workspaces", "items"], HERDR_COMMAND_TIMEOUT_MS, env);
	if (!workspaces.ok) {
		return {
			available: false,
			executable,
			error: workspaces.error,
			workspaces: [],
			panes: [],
			agents: [],
		};
	}
	const [panes, agents] = await Promise.all([
		runHerdrJsonArray(executable, ["pane", "list"], ["panes", "items"], HERDR_COMMAND_TIMEOUT_MS, env),
		runHerdrJsonArray(executable, ["agent", "list"], ["agents", "items"], HERDR_COMMAND_TIMEOUT_MS, env),
	]);
	return {
		available: true,
		executable,
		workspaces: workspaces.items,
		panes: panes.ok ? panes.items : [],
		agents: agents.ok ? agents.items : [],
		error: panes.error || agents.error || undefined,
	};
}

export async function listHerdrAgents(env: NodeJS.ProcessEnv = process.env): Promise<HerdrAgentListResult> {
	const executable = getHerdrExecutable(env);
	const response = await runHerdrJson(executable, ["agent", "list"], HERDR_COMMAND_TIMEOUT_MS, env);
	if (!response.ok) return { ok: false, executable, code: response.code || "herdr_unavailable", error: response.error || "Failed to list Herdr agents." };
	const agents = parseHerdrAgentListPayload(response.result);
	return { ok: true, executable, agents };
}

export async function readHerdrAgent(
	target: string | undefined,
	lines: number | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrAgentReadResult> {
	const normalizedTarget = target?.trim();
	if (!normalizedTarget) return { ok: false, message: "target is required." };
	const normalizedLines = normalizeLineCount(lines);
	const response = await runHerdrJson(
		getHerdrExecutable(env),
		["agent", "read", normalizedTarget, "--source", "recent", "--lines", String(normalizedLines), "--format", "text"],
		HERDR_READ_TIMEOUT_MS,
		env,
	);
	if (!response.ok) {
		return {
			ok: false,
			message: response.error || "Failed to read Herdr agent.",
			target: normalizedTarget,
			error: response.error,
			code: response.code,
		};
	}
	const read = isRecord(response.result) && isRecord(response.result.read) ? response.result.read : undefined;
	return {
		ok: true,
		message: "Read Herdr agent output.",
		target: normalizedTarget,
		text: typeof read?.text === "string" ? read.text : "",
		truncated: read?.truncated === true,
		revision: typeof read?.revision === "number" ? read.revision : undefined,
		stdout: response.stdout,
	};
}

export async function promptHerdrAgent(
	target: string | undefined,
	text: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrAgentActionResult> {
	const normalizedTarget = target?.trim();
	if (!normalizedTarget) return { ok: false, message: "target is required." };
	if (typeof text !== "string" || text.length === 0) return { ok: false, message: "text is required." };
	const response = await runHerdrJson(getHerdrExecutable(env), ["agent", "prompt", normalizedTarget, text], HERDR_SEND_TIMEOUT_MS, env);
	return herdrAgentActionResult(response, "Sent prompt to Herdr agent.", "Failed to prompt Herdr agent.");
}

export async function focusHerdrAgent(
	target: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrAgentActionResult> {
	const normalizedTarget = target?.trim();
	if (!normalizedTarget) return { ok: false, message: "target is required." };
	const response = await runHerdrJson(getHerdrExecutable(env), ["agent", "focus", normalizedTarget], HERDR_SEND_TIMEOUT_MS, env);
	return herdrAgentActionResult(response, "Focused Herdr agent.", "Failed to focus Herdr agent.");
}

export async function startHerdrAgent(
	name: string,
	kind: string,
	paneId: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrAgentStartResult> {
	const response = await runHerdrJson(
		getHerdrExecutable(env),
		["agent", "start", name, "--kind", kind, "--pane", paneId, "--", ...args],
		HERDR_SEND_TIMEOUT_MS,
		env,
	);
	const base = herdrAgentActionResult(response, "Started Herdr agent.", "Failed to start Herdr agent.");
	const result = response.ok && isRecord(response.result) && Array.isArray(response.result.argv)
		? response.result.argv.filter((value): value is string => typeof value === "string")
		: undefined;
	return { ...base, ...(result ? { argv: result } : {}) };
}

export async function readHerdrPane(paneId: string | undefined, lines: number | undefined, env: NodeJS.ProcessEnv = process.env): Promise<HerdrPaneReadResult> {
	const normalizedPaneId = paneId?.trim();
	if (!normalizedPaneId) return { ok: false, message: "paneId is required." };
	const normalizedLines = normalizeLineCount(lines);
	const result = await runHerdr(getHerdrExecutable(env), ["pane", "read", normalizedPaneId, "--source", "recent", "--lines", String(normalizedLines)], HERDR_READ_TIMEOUT_MS, env);
	return result.ok
		? { ok: true, message: "Read Herdr pane output.", paneId: normalizedPaneId, text: result.stdout || "" }
		: { ok: false, message: result.error || "Failed to read Herdr pane.", paneId: normalizedPaneId, error: result.error, code: result.code };
}

export async function sendHerdrPane(payload: HerdrPaneSendPayload | undefined, env: NodeJS.ProcessEnv = process.env): Promise<HerdrCommandResult> {
	const paneId = payload?.paneId?.trim();
	const text = payload?.text;
	if (!paneId) return { ok: false, message: "paneId is required." };
	if (typeof text !== "string" || text.length === 0) return { ok: false, message: "text is required." };
	const executable = getHerdrExecutable(env);
	const result = await (payload?.submit === false
		? runHerdr(executable, ["pane", "send-text", paneId, text], HERDR_SEND_TIMEOUT_MS, env)
		: runHerdr(executable, ["pane", "run", paneId, text], HERDR_SEND_TIMEOUT_MS, env));
	return result.ok
		? { ok: true, message: payload?.submit === false ? "Sent text to Herdr pane." : "Ran text in Herdr pane.", stdout: result.stdout }
		: { ok: false, message: result.error || "Failed to send text to Herdr pane.", error: result.error, code: result.code };
}

export async function sendHerdrAgent(payload: HerdrAgentSendPayload | undefined, env: NodeJS.ProcessEnv = process.env): Promise<HerdrCommandResult> {
	const agentId = payload?.agentId?.trim();
	const text = payload?.text;
	if (!agentId) return { ok: false, message: "agentId is required." };
	if (typeof text !== "string" || text.length === 0) return { ok: false, message: "text is required." };
	const result = await runHerdr(getHerdrExecutable(env), ["agent", "prompt", agentId, text], HERDR_SEND_TIMEOUT_MS, env);
	return result.ok
		? { ok: true, message: "Sent prompt to Herdr agent.", stdout: result.stdout }
		: { ok: false, message: result.error || "Failed to send text to Herdr agent.", error: result.error, code: result.code };
}

export function parseHerdrAgentListPayload(payload: unknown): HerdrAgentInfo[] {
	const result = isRecord(payload) && "result" in payload ? payload.result : payload;
	if (!isRecord(result)) return [];
	const agents = Array.isArray(result.agents) ? result.agents : Array.isArray(result.items) ? result.items : [];
	return agents.filter(isHerdrAgentInfo);
}

type HerdrArrayResult = {
	readonly ok: boolean;
	readonly items: readonly unknown[];
	readonly error?: string;
	readonly code?: string;
};

type HerdrProcessResult = {
	readonly ok: boolean;
	readonly stdout: string;
	readonly error?: string;
	readonly code?: string;
};

type HerdrJsonResult =
	| { readonly ok: true; readonly stdout: string; readonly result?: unknown }
	| { readonly ok: false; readonly stdout: string; readonly error: string; readonly code?: string };

async function runHerdrJsonArray(
	executable: string,
	args: readonly string[],
	keys: readonly string[],
	timeout: number,
	env: NodeJS.ProcessEnv,
): Promise<HerdrArrayResult> {
	const response = await runHerdrJson(executable, args, timeout, env);
	if (!response.ok) return { ok: false, items: [], error: response.error, code: response.code };
	const parsed = parseJson(response.stdout || "");
	if (Array.isArray(parsed)) return { ok: true, items: parsed };
	if (isRecord(parsed)) {
		for (const key of keys) {
			const value = parsed[key];
			if (Array.isArray(value)) return { ok: true, items: value };
		}
		const resultValue = parsed.result;
		if (Array.isArray(resultValue)) return { ok: true, items: resultValue };
		if (isRecord(resultValue)) {
			for (const key of keys) {
				const value = resultValue[key];
				if (Array.isArray(value)) return { ok: true, items: value };
			}
		}
	}
	return { ok: true, items: [] };
}

async function runHerdrJson(
	executable: string,
	args: readonly string[],
	timeout: number,
	env: NodeJS.ProcessEnv,
): Promise<HerdrJsonResult> {
	const result = await runHerdr(executable, args, timeout, env);
	const parsed = parseJson(result.stdout || "");
	if (!result.ok) {
		const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
		return {
			ok: false,
			stdout: result.stdout,
			error: typeof error?.message === "string" ? error.message : result.error || `${executable} failed`,
			code: typeof error?.code === "string" ? error.code : result.code,
		};
	}
	if (!isRecord(parsed)) return { ok: false, stdout: result.stdout, error: `${executable} returned invalid JSON.` };
	if (isRecord(parsed.error)) {
		return {
			ok: false,
			stdout: result.stdout,
			error: typeof parsed.error.message === "string" ? parsed.error.message : `${executable} failed`,
			code: typeof parsed.error.code === "string" ? parsed.error.code : undefined,
		};
	}
	return { ok: true, stdout: result.stdout, result: isRecord(parsed) && "result" in parsed ? parsed.result : parsed };
}

function herdrAgentActionResult(response: HerdrJsonResult, successMessage: string, failureMessage: string): HerdrAgentActionResult {
	if (!response.ok) {
		return { ok: false, message: response.error || failureMessage, error: response.error, code: response.code, stdout: response.stdout };
	}
	const agent = isRecord(response.result) && isHerdrAgentInfo(response.result.agent) ? response.result.agent : undefined;
	return { ok: true, message: successMessage, agent, stdout: response.stdout };
}

function runHerdr(
	executable: string,
	args: readonly string[],
	timeout: number,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrProcessResult> {
	const { promise, resolve } = Promise.withResolvers<HerdrProcessResult>();
	const child = spawn(executable, [...args], {
		windowsHide: true,
		env: { ...process.env, ...env },
	});
	let stdout = "";
	let stderr = "";
	let settled = false;
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		child.kill();
		resolve({ ok: false, stdout, error: `${executable} timed out after ${timeout}ms`, code: "timeout" });
	}, timeout);
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
		clearTimeout(timer);
		resolve({ ok: false, stdout: "", error: error.message, code: "spawn_failed" });
	});
	child.on("close", (code) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (code !== 0) {
			const parsed = parseJson(stderr.trim() || stdout.trim());
			const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
			resolve({
				ok: false,
				stdout,
				error: typeof error?.message === "string" ? error.message : (stderr || stdout || `${executable} exited with ${code}`).trim(),
				code: typeof error?.code === "string" ? error.code : "exit_failed",
			});
			return;
		}
		resolve({ ok: true, stdout });
	});
	return promise;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHerdrAgentInfo(value: unknown): value is HerdrAgentInfo {
	if (!isRecord(value)) return false;
	return typeof value.terminal_id === "string"
		&& typeof value.workspace_id === "string"
		&& typeof value.tab_id === "string"
		&& typeof value.pane_id === "string"
		&& typeof value.agent_status === "string"
		&& typeof value.revision === "number";
}

function normalizeLineCount(lines: number | undefined): number {
	if (typeof lines !== "number" || !Number.isFinite(lines)) return 50;
	return Math.min(500, Math.max(1, Math.trunc(lines)));
}
