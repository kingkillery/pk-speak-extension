import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `/upload-chat` — move the current repo state (and chat) between hosts, as an
 * abstraction over the repo's own `scripts/codespace-sync.ts`:
 *
 *   /upload-chat mac2            -> push (upload) repo state TO mac2
 *   /upload-chat push mac2       -> same, explicit
 *   /upload-chat pull mac2       -> bring mac2's repo state BACK here (staged, non-destructive)
 *   /upload-chat status mac2     -> dry-run: what would transfer
 *   /upload-chat worktree mac2 --name task-name -> create a separate remote workspace from exact local state
 *
 * Direction never lies: "upload" always means push. The host is an ssh alias
 * (`~/.ssh/config`), a `PI_SPEAK_SYNC_HOSTS` alias ("mac2=k@100.109.244.1 ..."),
 * or a raw `user@host` target.
 */

export type UploadChatAction = "push" | "pull" | "status" | "worktree";

export type UploadChatArgs = {
	action: UploadChatAction;
	host: string;
	cwd?: string;
	syncArgs: string[];
};

export function parseUploadChatArgs(raw: string): { ok: true; args: UploadChatArgs } | { ok: false; error: string } {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	let action: UploadChatAction = "push";
	let cwd: string | undefined;
	const positional: string[] = [];
	const syncArgs: string[] = [];
	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (part === "push" || part === "pull" || part === "status" || part === "worktree") {
			action = part;
			continue;
		}
		if (part === "--cwd") {
			cwd = parts[i + 1];
			i += 1;
			continue;
		}
		if (part === "--name" || part === "--path") {
			const value = parts[i + 1];
			if (!value) {
				return { ok: false, error: `${part} requires a value` };
			}
			syncArgs.push(part, value);
			i += 1;
			continue;
		}
		positional.push(part);
	}
	const host = positional[0];
	if (!host) {
		return { ok: false, error: "Usage: /upload-chat [push|pull|status|worktree] <host> [--name <workspace-name>|--path <remote-dir>] [--cwd <path>]" };
	}
	if (positional.length > 1) {
		return { ok: false, error: `Unexpected extra arguments: ${positional.slice(1).join(" ")}` };
	}
	return { ok: true, args: { action, host, syncArgs, ...(cwd ? { cwd } : {}) } };
}

/** Resolve "name=user@host" pairs from PI_SPEAK_SYNC_HOSTS; unknown names pass through (ssh aliases still work). */
export function resolveSyncHost(host: string, env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.PI_SPEAK_SYNC_HOSTS ?? "";
	for (const entry of raw.split(/[\s,;]+/)) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		if (entry.slice(0, eq).trim().toLowerCase() === host.trim().toLowerCase()) {
			const target = entry.slice(eq + 1).trim();
			if (target) return target;
		}
	}
	return host.trim();
}

/** Walk up from `startCwd` to the git root looking for scripts/codespace-sync.ts. */
export function resolveSyncScript(startCwd: string, pathExists: (path: string) => boolean = existsSync): { repoRoot: string; script: string } | undefined {
	let current = startCwd;
	for (let depth = 0; depth < 30; depth += 1) {
		const script = join(current, "scripts", "codespace-sync.ts");
		if (pathExists(script)) return { repoRoot: current, script };
		if (pathExists(join(current, ".git"))) return undefined; // repo root reached without the script
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

export type UploadChatRunResult = {
	ok: boolean;
	exitCode: number | null;
	output: string;
};

/** Run `bun scripts/codespace-sync.ts <action> <target> [...syncArgs]` in the repo root. */
export function runCodespaceSync(
	script: string,
	repoRoot: string,
	action: UploadChatAction,
	target: string,
	syncArgs: string[] = [],
	timeoutMs = 15 * 60 * 1000,
): Promise<UploadChatRunResult> {
	const { promise, resolve } = Promise.withResolvers<UploadChatRunResult>();
	const child = spawn("bun", [script, action, target, ...syncArgs], { cwd: repoRoot, windowsHide: true });
	const chunks: Buffer[] = [];
	const timer = setTimeout(() => {
		child.kill();
		resolve({ ok: false, exitCode: null, output: `${Buffer.concat(chunks).toString("utf8")}\n[timed out after ${Math.round(timeoutMs / 60000)}m]` });
	}, timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
	child.on("error", (error) => {
		clearTimeout(timer);
		resolve({ ok: false, exitCode: null, output: `${Buffer.concat(chunks).toString("utf8")}\nspawn failed: ${error.message}` });
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		resolve({ ok: code === 0, exitCode: code, output: Buffer.concat(chunks).toString("utf8") });
	});
	return promise;
}

/** Compact tail of sync output for chat/voice display. */
export function summarizeSyncOutput(output: string, maxLines = 12): string {
	const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
	return lines.slice(-maxLines).join("\n");
}
