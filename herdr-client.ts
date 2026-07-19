import { spawn } from "node:child_process";

export type HerdrCommandResult = {
	readonly ok: boolean;
	readonly message: string;
	readonly stdout?: string;
	readonly error?: string;
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

const HERDR_COMMAND_TIMEOUT_MS = 5000;
const HERDR_READ_TIMEOUT_MS = 5000;
const HERDR_SEND_TIMEOUT_MS = 10000;

export function getHerdrExecutable(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SPEAK_HERDR_BIN?.trim() || env.HERDR_BIN_PATH?.trim() || "herdr";
}

export async function buildHerdrSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<HerdrSnapshot> {
	const executable = getHerdrExecutable(env);
	const workspaces = await runHerdrJsonArray(executable, ["workspace", "list"], ["workspaces", "items"], HERDR_COMMAND_TIMEOUT_MS);
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
		runHerdrJsonArray(executable, ["pane", "list"], ["panes", "items"], HERDR_COMMAND_TIMEOUT_MS),
		runHerdrJsonArray(executable, ["agent", "list"], ["agents", "items"], HERDR_COMMAND_TIMEOUT_MS),
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

export async function readHerdrPane(paneId: string | undefined, lines: number | undefined, env: NodeJS.ProcessEnv = process.env): Promise<HerdrPaneReadResult> {
	const normalizedPaneId = paneId?.trim();
	if (!normalizedPaneId) return { ok: false, message: "paneId is required." };
	const normalizedLines = normalizeLineCount(lines);
	const result = await runHerdr(getHerdrExecutable(env), ["pane", "read", normalizedPaneId, "--source", "recent", "--lines", String(normalizedLines)], HERDR_READ_TIMEOUT_MS);
	return result.ok
		? { ok: true, message: "Read Herdr pane output.", paneId: normalizedPaneId, text: result.stdout || "" }
		: { ok: false, message: result.error || "Failed to read Herdr pane.", paneId: normalizedPaneId, error: result.error };
}

export async function sendHerdrPane(payload: HerdrPaneSendPayload | undefined, env: NodeJS.ProcessEnv = process.env): Promise<HerdrCommandResult> {
	const paneId = payload?.paneId?.trim();
	const text = payload?.text;
	if (!paneId) return { ok: false, message: "paneId is required." };
	if (typeof text !== "string" || text.length === 0) return { ok: false, message: "text is required." };
	const executable = getHerdrExecutable(env);
	const result = await (payload?.submit === false
		? runHerdr(executable, ["pane", "send-text", paneId, text], HERDR_SEND_TIMEOUT_MS)
		: runHerdr(executable, ["pane", "run", paneId, text], HERDR_SEND_TIMEOUT_MS));
	return result.ok
		? { ok: true, message: payload?.submit === false ? "Sent text to Herdr pane." : "Ran text in Herdr pane.", stdout: result.stdout }
		: { ok: false, message: result.error || "Failed to send text to Herdr pane.", error: result.error };
}

export async function sendHerdrAgent(payload: HerdrAgentSendPayload | undefined, env: NodeJS.ProcessEnv = process.env): Promise<HerdrCommandResult> {
	const agentId = payload?.agentId?.trim();
	const text = payload?.text;
	if (!agentId) return { ok: false, message: "agentId is required." };
	if (typeof text !== "string" || text.length === 0) return { ok: false, message: "text is required." };
	const result = await runHerdr(getHerdrExecutable(env), ["agent", "send", agentId, text], HERDR_SEND_TIMEOUT_MS);
	return result.ok
		? { ok: true, message: "Sent text to Herdr agent.", stdout: result.stdout }
		: { ok: false, message: result.error || "Failed to send text to Herdr agent.", error: result.error };
}

type HerdrArrayResult = {
	readonly ok: boolean;
	readonly items: readonly unknown[];
	readonly error?: string;
};

type HerdrProcessResult = {
	readonly ok: boolean;
	readonly stdout: string;
	readonly error?: string;
};

async function runHerdrJsonArray(executable: string, args: readonly string[], keys: readonly string[], timeout: number): Promise<HerdrArrayResult> {
	const result = await runHerdr(executable, args, timeout);
	if (!result.ok) return { ok: false, items: [], error: result.error };
	const parsed = parseJson(result.stdout || "");
	if (Array.isArray(parsed)) return { ok: true, items: parsed };
	if (isRecord(parsed)) {
		for (const key of keys) {
			const value = parsed[key];
			if (Array.isArray(value)) return { ok: true, items: value };
		}
		const resultValue = parsed.result;
		if (Array.isArray(resultValue)) return { ok: true, items: resultValue };
	}
	return { ok: true, items: [] };
}

function runHerdr(executable: string, args: readonly string[], timeout: number): Promise<HerdrProcessResult> {
	const { promise, resolve } = Promise.withResolvers<HerdrProcessResult>();
	const child = spawn(executable, [...args], { windowsHide: true });
	let stdout = "";
	let stderr = "";
	let settled = false;
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		child.kill();
		resolve({ ok: false, stdout, error: `${executable} timed out after ${timeout}ms` });
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
		resolve({ ok: false, stdout: "", error: error.message });
	});
	child.on("close", (code) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (code !== 0) {
			resolve({ ok: false, stdout, error: (stderr || stdout || `${executable} exited with ${code}`).trim() });
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

function normalizeLineCount(lines: number | undefined): number {
	if (typeof lines !== "number" || !Number.isFinite(lines)) return 50;
	return Math.min(500, Math.max(1, Math.trunc(lines)));
}
