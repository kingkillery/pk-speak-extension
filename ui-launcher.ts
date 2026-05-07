import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type SpawnLike = (
	command: string,
	args: ReadonlyArray<string>,
	options: SpawnOptions,
) => { unref?: () => void };

export interface LaunchSessionManagerPaneOptions {
	spawnImpl?: SpawnLike;
	platform?: NodeJS.Platform;
	adminScriptPath?: string;
	nodeBinary?: string;
	currentSessionPath?: string;
	currentSessionName?: string;
	lockPath?: string;
}

export interface LaunchSessionManagerPaneResult {
	spawned: boolean;
	reused?: boolean;
	command?: string;
	args?: string[];
	detached?: boolean;
	manualCommand: string;
	reason?: string;
}

export function getSessionManagerPaneLockPath(): string {
	return join(tmpdir(), "pi-speak-admin-pane.lock.json");
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLockedPanePid(lockPath: string): number | undefined {
	if (!existsSync(lockPath)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
		return typeof raw.pid === "number" ? raw.pid : undefined;
	} catch {
		return undefined;
	}
}

function getRunningPanePid(lockPath = getSessionManagerPaneLockPath()): number | undefined {
	const pid = readLockedPanePid(lockPath);
	if (pid && isProcessAlive(pid)) return pid;
	if (pid) {
		try {
			rmSync(lockPath, { force: true });
		} catch {}
	}
	return undefined;
}

export function resolveAdminScriptPath(override?: string): string {
	if (override) return resolve(override);
	return join(__dirname, "ui", "admin.js");
}

function buildAdminCliArgs(options: LaunchSessionManagerPaneOptions, adminScriptPath: string): string[] {
	const args = [adminScriptPath];
	if (options.currentSessionPath) {
		args.push("--current-path", options.currentSessionPath);
	}
	if (options.currentSessionName) {
		args.push("--current-name", options.currentSessionName);
	}
	return args;
}

function formatManualCommand(nodeBinary: string, args: string[]): string {
	const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
	return [quote(nodeBinary), ...args.map(quote)].join(" ");
}

export function launchSessionManagerPane(
	options: LaunchSessionManagerPaneOptions = {},
): LaunchSessionManagerPaneResult {
	const platform = options.platform ?? process.platform;
	const spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnLike);
	const nodeBinary = options.nodeBinary ?? process.execPath;
	const adminScriptPath = resolveAdminScriptPath(options.adminScriptPath);
	const adminArgs = buildAdminCliArgs(options, adminScriptPath);
	const manualCommand = formatManualCommand(nodeBinary, adminArgs);
	const runningPanePid = getRunningPanePid(options.lockPath);

	if (runningPanePid) {
		return {
			spawned: false,
			reused: true,
			manualCommand,
			reason: `Session manager pane is already running (pid ${runningPanePid}).`,
		};
	}

	if (!options.adminScriptPath && !existsSync(adminScriptPath)) {
		return {
			spawned: false,
			manualCommand,
			reason: `Admin CLI not found at ${adminScriptPath}. Run "npm run build:ui" first.`,
		};
	}

	if (platform === "win32") {
		const command = "cmd.exe";
		const args = ["/c", "start", "", nodeBinary, ...adminArgs];
		const child = spawnImpl(command, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: false,
			shell: false,
		});
		if (child && typeof child.unref === "function") child.unref();
		return {
			spawned: true,
			command,
			args,
			detached: true,
			manualCommand,
		};
	}

	return {
		spawned: false,
		manualCommand,
		reason: `No terminal-emulator launcher is configured for platform "${platform}". Run the command manually.`,
	};
}
