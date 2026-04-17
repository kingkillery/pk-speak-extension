import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
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
}

export interface LaunchSessionManagerPaneResult {
	spawned: boolean;
	command?: string;
	args?: string[];
	detached?: boolean;
	manualCommand: string;
	reason?: string;
}

export function resolveAdminScriptPath(override?: string): string {
	if (override) return resolve(override);
	return join(__dirname, "ui", "admin.js");
}

function formatManualCommand(nodeBinary: string, adminScriptPath: string): string {
	const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
	return `${quote(nodeBinary)} ${quote(adminScriptPath)}`;
}

export function launchSessionManagerPane(
	options: LaunchSessionManagerPaneOptions = {},
): LaunchSessionManagerPaneResult {
	const platform = options.platform ?? process.platform;
	const spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnLike);
	const nodeBinary = options.nodeBinary ?? process.execPath;
	const adminScriptPath = resolveAdminScriptPath(options.adminScriptPath);
	const manualCommand = formatManualCommand(nodeBinary, adminScriptPath);

	if (!options.adminScriptPath && !existsSync(adminScriptPath)) {
		return {
			spawned: false,
			manualCommand,
			reason: `Admin CLI not found at ${adminScriptPath}. Run "npm run build:ui" first.`,
		};
	}

	if (platform === "win32") {
		const command = "cmd.exe";
		const args = ["/c", "start", "", nodeBinary, adminScriptPath];
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
