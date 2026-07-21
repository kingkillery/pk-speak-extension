import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type DesktopLiveClientLaunchMode = "edge-app" | "default-browser";

export type DesktopLiveClientLaunchResult = {
	mode: DesktopLiveClientLaunchMode;
	url: string;
	pid?: number;
	/**
	 * Settles once the launcher child either spawns or fails. Command-not-found
	 * (ENOENT on xdg-open/explorer/Edge) surfaces as an ASYNC "error" event —
	 * a synchronous try/catch around the call can never observe it. Callers
	 * that must know the UI actually opened (e.g. the speech orb path, which
	 * deletes the synthesized temp file on success) MUST await this instead of
	 * trusting the synchronous return. Resolves ok:true after a short grace
	 * window when neither event fires (detached stubs/exotic launchers).
	 */
	launched: Promise<{ ok: true } | { ok: false; error: string }>;
};

type SpawnedProcess = {
	pid?: number;
	on(event: string, listener: (...args: unknown[]) => void): SpawnedProcess;
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

/**
 * Builds the orb URL for one-shot TTS playback (NOT realtime Live).
 *
 * Speech mode is distinct from the live conversation flow: it does NOT set
 * autoconnect=1, the orb must not open /v1/live, and the only audio source
 * is the staged artifact identified by `speechId`. The operator gets a
 * text panel + HTML5 audio element (pause/resume) + Stop + Disable speech
 * controls; nothing auto-plays.
 *
 * Query keys are deliberately distinct from the live/auth flow: `speech`
 * is the opaque short-lived artifact id, `token` is the gateway auth token
 * (mirrors the rest of the auth surface).
 */
export function buildDesktopSpeechClientUrl(
	port: number,
	speechId: string,
	options: { cwd?: string; surface?: "orb" | "app"; authToken?: string } = {},
): string {
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid Pi Speak gateway port: ${port}`);
	}
	const id = speechId.trim();
	if (!id) throw new Error("Speech id is required for speech-mode orb url");
	const surface = options.surface ?? "orb";
	const path = surface === "app" ? "/app/" : "/orb/";
	const url = new URL(`http://127.0.0.1:${port}${path}`);
	url.searchParams.set("mode", "speech");
	url.searchParams.set("speech", id);
	const launchCwd = options.cwd?.trim();
	if (launchCwd) url.searchParams.set("cwd", launchCwd);
	if (options.authToken) url.searchParams.set("token", options.authToken);
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
	const url = buildDesktopLiveClientUrl(options.port, options.cwd);
	return spawnDesktopClientUrl(url, options);
}

/**
 * Opens the orb in speech mode for one-shot TTS playback. Mirrors
 * openDesktopLiveClient's platform dispatch but uses the speech-mode URL
 * (no autoconnect=1, no /v1/live).
 */
export function openDesktopSpeechClient(
	options: DesktopLiveClientOptions & { speechId: string; authToken?: string },
): DesktopLiveClientLaunchResult {
	const url = buildDesktopSpeechClientUrl(options.port, options.speechId, {
		cwd: options.cwd,
		authToken: options.authToken,
	});
	return spawnDesktopClientUrl(url, options);
}

function spawnDesktopClientUrl(url: string, options: DesktopLiveClientOptions): DesktopLiveClientLaunchResult {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? existsSync;
	const spawnProcess = options.spawnProcess ?? (spawn as unknown as SpawnProcess);

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
	const launched = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
		let settled = false;
		const settle = (value: { ok: true } | { ok: false; error: string }) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		child.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			settle({ ok: false, error: message });
		});
		child.on("spawn", () => settle({ ok: true }));
		// Grace window: test stubs and some detached launchers never emit
		// either event; treat "no error within the window" as started.
		const timer = setTimeout(() => settle({ ok: true }), 1_500);
		(timer as { unref?: () => void }).unref?.();
	});
	child.unref();
	return { mode, url, pid: child.pid, launched };
}
