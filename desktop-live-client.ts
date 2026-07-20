import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type DesktopLiveClientLaunchMode = "edge-app" | "default-browser";

export type DesktopLiveClientLaunchResult = {
	mode: DesktopLiveClientLaunchMode;
	url: string;
	pid?: number;
};

type SpawnedProcess = {
	pid?: number;
	on(event: "error", listener: (error: Error) => void): SpawnedProcess;
	unref(): void;
};

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

type DesktopLiveClientOptions = {
	port: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	pathExists?: (path: string) => boolean;
	spawnProcess?: SpawnProcess;
};

export function buildDesktopLiveClientUrl(port: number, cwd?: string, surface: "orb" | "app" = "orb"): string {
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid Pi Speak gateway port: ${port}`);
	}
	// Terminal users get the floating orb companion (/orb/), not the full remote chrome.
	const path = surface === "app" ? "/app/" : "/orb/";
	const url = new URL(`http://127.0.0.1:${port}${path}`);
	url.searchParams.set("mode", "live");
	url.searchParams.set("autoconnect", "1");
	const launchCwd = cwd?.trim();
	if (launchCwd) url.searchParams.set("cwd", launchCwd);
	return url.toString();
}

export function findEdgePath(
	env: NodeJS.ProcessEnv = process.env,
	pathExists: (path: string) => boolean = existsSync,
): string | null {
	const candidates = [
		env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
		env.ProgramFiles && join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
		env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
	].filter((candidate): candidate is string => !!candidate);
	return candidates.find((candidate) => pathExists(candidate)) || null;
}

export function openDesktopLiveClient(options: DesktopLiveClientOptions): DesktopLiveClientLaunchResult {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? existsSync;
	const spawnProcess = options.spawnProcess ?? (spawn as unknown as SpawnProcess);
	const url = buildDesktopLiveClientUrl(options.port, options.cwd);

	let command: string;
	let args: string[];
	let mode: DesktopLiveClientLaunchMode;
	let spawnOptions: SpawnOptions;

	if (platform === "win32") {
		const edge = findEdgePath(env, pathExists);
		if (edge) {
			command = edge;
			args = [`--app=${url}`];
			mode = "edge-app";
		} else {
			command = "explorer.exe";
			args = [url];
			mode = "default-browser";
		}
		spawnOptions = { stdio: "ignore", detached: true, windowsHide: true };
	} else {
		command = platform === "darwin" ? "open" : "xdg-open";
		args = [url];
		mode = "default-browser";
		spawnOptions = { stdio: "ignore", detached: true };
	}

	const child = spawnProcess(command, args, spawnOptions);
	child.on("error", () => {});
	child.unref();
	return { mode, url, pid: child.pid };
}
