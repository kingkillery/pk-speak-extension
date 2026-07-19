#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const MAX_MCP_SPEAK_TEXT_CHARS = 4_000;
export const MAX_MCP_VOICE_CHARS = 128;
export const MAX_MCP_STDERR_BYTES = 8_192;
export const DEFAULT_MCP_SPEAK_TIMEOUT_MS = 45_000;
export const MAX_MCP_SPEAK_TIMEOUT_MS = 120_000;

type SpawnCommand = typeof spawn;

type RunPkSpeakOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	entrypoint?: string;
	spawnCommand?: SpawnCommand;
};

type PkSpeakRunResult = {
	code: number;
	stderr: string;
};

const activeChildren = new Set<ChildProcess>();

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boundedTimeout(value: number | undefined): number {
	if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_MCP_SPEAK_TIMEOUT_MS;
	return Math.min(Math.floor(value), MAX_MCP_SPEAK_TIMEOUT_MS);
}

function configuredTimeout(): number {
	return boundedTimeout(Number.parseInt(process.env.PK_SPEAK_MCP_TIMEOUT_MS || "", 10));
}

function appendBoundedStderr(current: Buffer, chunk: Buffer): Buffer {
	if (current.length >= MAX_MCP_STDERR_BYTES) return current;
	return Buffer.concat([current, chunk.subarray(0, MAX_MCP_STDERR_BYTES - current.length)]);
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function terminateChild(child: ChildProcess): Promise<void> {
	if (hasExited(child)) return;
	if (process.platform === "win32" && child.pid) {
		try {
			const taskkill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
				shell: false,
			});
			const killed = await Promise.race([
				once(taskkill, "close").then(([code]) => code === 0),
				once(taskkill, "error").then(() => false),
			]);
			if (killed || hasExited(child)) return;
		} catch {}
	}
	try {
		child.kill("SIGTERM");
	} catch {
		return;
	}
	const escalation = setTimeout(() => {
		if (hasExited(child)) return;
		try {
			child.kill("SIGKILL");
		} catch {}
	}, 1_000);
	escalation.unref();
}

export async function stopActivePkSpeakSubprocesses(): Promise<void> {
	await Promise.all([...activeChildren].map((child) => terminateChild(child)));
}

export function resolvePkSpeakEntrypoint(moduleUrl = import.meta.url): string {
	return join(dirname(fileURLToPath(moduleUrl)), "pk-speak.js");
}

function validateSpeechInput(text: string): void {
	if (!text.trim()) throw new Error("Speech text is required.");
	if (text.length > MAX_MCP_SPEAK_TEXT_CHARS) {
		throw new Error(`Speech text exceeds the ${MAX_MCP_SPEAK_TEXT_CHARS}-character limit.`);
	}
}

/**
 * Runs the bundled dispatcher, not a global pk-speak command. The request
 * signal, timeout, and process shutdown all terminate the child process.
 */
export function runPkSpeak(text: string, options: RunPkSpeakOptions = {}): Promise<PkSpeakRunResult> {
	validateSpeechInput(text);
	return runPkSpeakChild(text, options);
}

async function runPkSpeakChild(text: string, options: RunPkSpeakOptions): Promise<PkSpeakRunResult> {
	options.signal?.throwIfAborted();
	const spawnCommand = options.spawnCommand ?? spawn;
	const timeoutMs = boundedTimeout(options.timeoutMs ?? configuredTimeout());
	const entrypoint = options.entrypoint ?? resolvePkSpeakEntrypoint();
	const child = spawnCommand(process.execPath, [entrypoint, "speak", "--quiet", "--gate", "immediate", "--", text], {
		stdio: ["ignore", "ignore", "pipe"],
		windowsHide: true,
		shell: false,
	});

	activeChildren.add(child);
	const removeActiveChild = () => activeChildren.delete(child);
	child.once("close", removeActiveChild);
	child.once("error", removeActiveChild);
	let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	const onStderr = (chunk: Buffer | string) => {
		stderr = appendBoundedStderr(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	};
	child.stderr?.on("data", onStderr);
	const cleanup = new AbortController();
	const close: Promise<PkSpeakRunResult> = once(child, "close", { signal: cleanup.signal }).then(([rawCode]) => {
		const code = typeof rawCode === "number" ? rawCode : 1;
		const result = { code, stderr: stderr.toString("utf8") };
		if (code === 0) return result;
		throw new Error(result.stderr.trim() || `pk-speak exited with code ${code}`);
	});
	const failed: Promise<never> = once(child, "error", { signal: cleanup.signal }).then(([error]) => {
		throw error;
	});
	const cancelled: Promise<never> | undefined = options.signal
		? once(options.signal, "abort", { signal: cleanup.signal }).then(async () => {
			await terminateChild(child);
			throw new Error("Speech request cancelled.");
		})
		: undefined;
	const timedOut: Promise<never> = delay(timeoutMs, undefined, { signal: cleanup.signal }).then(async () => {
		await terminateChild(child);
		throw new Error(`Speech request timed out after ${timeoutMs}ms.`);
	});
	try {
		return await Promise.race([close, failed, timedOut, ...(cancelled ? [cancelled] : [])]);
	} finally {
		cleanup.abort();
		child.stderr?.removeListener("data", onStderr);
	}
}

function createServer(): McpServer {
	const server = new McpServer({ name: "pk-speak", version: "0.2.11" });
	server.registerTool(
		"speak",
		{
			description: "Speak a short natural-language status update through the locally bundled pk-speak CLI.",
			inputSchema: {
				text: z.string().trim().min(1).max(MAX_MCP_SPEAK_TEXT_CHARS).describe("Short plain-language text to speak."),
				voice: z.string().trim().min(1).max(MAX_MCP_VOICE_CHARS).optional().describe("Unsupported per-request voice override."),
			},
		},
		async ({ text, voice }, extra) => {
			try {
				if (voice) throw new Error("Per-request voice overrides are not supported; configure the CLI voice instead.");
				await runPkSpeak(text, { signal: extra.signal });
				return { content: [{ type: "text", text: "Spoke." }] };
			} catch (error) {
				return {
					content: [{ type: "text", text: `Speech failed: ${getErrorMessage(error)}` }],
					isError: true,
				};
			}
		},
	);
	return server;
}

function isRunningAsBin(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const server = createServer();
	const transport = new StdioServerTransport();
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		void (async () => {
			await stopActivePkSpeakSubprocesses();
			const deadline = Date.now() + 1_250;
			while (activeChildren.size > 0 && Date.now() < deadline) await delay(25);
			await server.close().catch(() => {});
			process.exit(0);
		})();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	await server.connect(transport);
	console.error("pk-speak MCP server running on stdio.");
}

if (isRunningAsBin()) {
	void main().catch((error) => {
		console.error(`pk-speak MCP server fatal error: ${getErrorMessage(error)}`);
		process.exitCode = 1;
	});
}
