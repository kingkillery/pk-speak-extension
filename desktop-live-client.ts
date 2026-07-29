import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export type DesktopLiveClientLaunchMode = "floating-host" | "edge-app" | "default-browser";

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

export type DesktopBrowserCandidate = {
	path: string;
	source: "default" | "edge" | "chrome";
	supportsAppMode: boolean;
};

type DesktopLiveClientOptions = {
	port: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	pathExists?: (path: string) => boolean;
	spawnProcess?: SpawnProcess;
	/**
	 * Prefer the floating companion host (default-browser/--app + pin) when
	 * available. Defaults true. Callers can force plain browser/app mode.
	 */
	preferFloatingHost?: boolean;
	/**
	 * Optional resolver for the OS default browser executable. Tests inject this.
	 */
	resolveDefaultBrowserPath?: () => string | null;
};

function moduleDirname(): string {
	return dirname(fileURLToPath(import.meta.url));
}

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

export function findChromePath(
	env: NodeJS.ProcessEnv = process.env,
	pathExists: (path: string) => boolean = existsSync,
): string | null {
	const candidates = [
		env.ProgramFiles && join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
		env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
		env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
	].filter((candidate): candidate is string => !!candidate);
	return candidates.find((candidate) => pathExists(candidate)) || null;
}

/**
 * Chromium-family browsers generally support --app= companion windows.
 * Unknown browsers still work via default URL open, without app-mode.
 */
export function browserSupportsAppMode(browserPath: string): boolean {
	const base = browserPath.replace(/\\/g, "/").toLowerCase();
	return (
		base.endsWith("/msedge.exe") ||
		base.endsWith("/chrome.exe") ||
		base.endsWith("/brave.exe") ||
		base.endsWith("/comet.exe") ||
		base.includes("/comet") ||
		base.includes("chrome") ||
		base.includes("msedge") ||
		base.includes("brave") ||
		base.includes("chromium") ||
		base.includes("vivaldi") ||
		base.includes("opera")
	);
}

/**
 * Resolve the Windows default HTTP browser executable from UserChoice ProgId.
 * Returns null on non-Windows or when resolution fails.
 */
export function resolveWindowsDefaultBrowserPath(): string | null {
	if (process.platform !== "win32") return null;
	try {
		const ps = [
			"$p = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice').ProgId",
			"if (-not $p) { exit 2 }",
			"$cmd = (Get-ItemProperty (\"Registry::HKEY_CLASSES_ROOT\\$p\\shell\\open\\command\")).'(default)'",
			"if (-not $cmd) { exit 3 }",
			"if ($cmd -match '\"([^\"]+\\.exe)\"') { $matches[1] } elseif ($cmd -match '([^\\s]+\\.exe)') { $matches[1] } else { exit 4 }",
		].join("; ");
		const out = execFileSync(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
			{ encoding: "utf8", windowsHide: true, timeout: 4000 },
		).trim();
		if (!out || !existsSync(out)) return null;
		return out;
	} catch {
		return null;
	}
}

/**
 * Prefer OS default browser (e.g. Comet), then Chrome, then Edge.
 * Edge is an explicit fallback — never the assumed product browser.
 */
export function resolvePreferredBrowserCandidate(options: {
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => boolean;
	resolveDefaultBrowserPath?: () => string | null;
} = {}): DesktopBrowserCandidate | null {
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? existsSync;
	const resolveDefault = options.resolveDefaultBrowserPath ?? resolveWindowsDefaultBrowserPath;

	const defaultPath = resolveDefault()?.trim() || null;
	if (defaultPath && pathExists(defaultPath)) {
		return {
			path: defaultPath,
			source: "default",
			supportsAppMode: browserSupportsAppMode(defaultPath),
		};
	}

	const chrome = findChromePath(env, pathExists);
	if (chrome) {
		return { path: chrome, source: "chrome", supportsAppMode: true };
	}

	const edge = findEdgePath(env, pathExists);
	if (edge) {
		return { path: edge, source: "edge", supportsAppMode: true };
	}

	return null;
}

/**
 * Locate the Windows floating-host pin script. Capability-checked: if the
 * script is missing we fall back to plain app-mode / default browser.
 */
export function findOrbDesktopHostScript(
	cwd?: string,
	pathExists: (path: string) => boolean = existsSync,
): string | null {
	const candidates = [
		cwd && join(cwd, "scripts", "orb-desktop-host.ps1"),
		join(moduleDirname(), "..", "scripts", "orb-desktop-host.ps1"),
		join(moduleDirname(), "scripts", "orb-desktop-host.ps1"),
		join(process.cwd(), "scripts", "orb-desktop-host.ps1"),
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
	const preferFloatingHost = options.preferFloatingHost !== false;

	let command: string;
	let args: string[];
	let mode: DesktopLiveClientLaunchMode;
	let spawnOptions: SpawnOptions;

	if (platform === "win32") {
		const browser = resolvePreferredBrowserCandidate({
			env,
			pathExists,
			resolveDefaultBrowserPath: options.resolveDefaultBrowserPath,
		});
		const hostScript = preferFloatingHost ? findOrbDesktopHostScript(options.cwd, pathExists) : null;

		if (hostScript && browser?.supportsAppMode) {
			// Floating companion via the user's preferred Chromium browser.
			command = "powershell.exe";
			args = [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				hostScript,
				"-Url",
				url,
				"-BrowserPath",
				browser.path,
			];
			mode = "floating-host";
		} else if (browser?.supportsAppMode) {
			command = browser.path;
			args = [`--app=${url}`];
			// Keep mode label stable for telemetry; edge-app historically meant chromium app window.
			mode = browser.source === "edge" ? "edge-app" : "edge-app";
		} else if (browser) {
			command = browser.path;
			args = [url];
			mode = "default-browser";
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
		if (timer && typeof timer === "object" && "unref" in timer) {
			const maybeUnref = timer.unref;
			if (typeof maybeUnref === "function") maybeUnref.call(timer);
		}
	});
	child.unref();
	return { mode, url, pid: child.pid, launched };
}
