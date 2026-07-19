import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { platform as currentPlatform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type AudioPlayerInvocation = {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
};

export type AudioPlaybackResult = "played" | "opened" | "started" | "skipped";

export type AudioPlaybackOptions = {
	allowOpenFallback?: boolean;
	wait?: boolean;
	cleanupDir?: string;
	signal?: AbortSignal;
};

type PathLookup = (command: string) => boolean;
type SpawnCommand = typeof spawn;

const DETACHED_SUPERVISOR_FLAG = "--supervise-playback";
const PLAYER_KILL_GRACE_MS = 1_000;

export function existsOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = currentPlatform()): boolean {
	const isWindows = platform === "win32";
	const pathDirs = (env.PATH || "").split(isWindows ? ";" : ":");
	const extensions = isWindows
		? [...(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((value) => value.trim()).filter(Boolean), ""]
		: [""];
	return pathDirs.some((directory) => directory && extensions.some((extension) => existsSync(join(directory, command + extension))));
}

/** Keep the established Unix preference order: PulseAudio, mpg123, then ffplay. */
export function getUnixAudioPlayer(
	allowOpenFallback = false,
	lookup: PathLookup = existsOnPath,
	platform = currentPlatform(),
): string | undefined {
	if (platform === "darwin") return "afplay";
	for (const command of ["paplay", "mpg123", "ffplay"]) {
		if (lookup(command)) return command;
	}
	return allowOpenFallback ? "xdg-open" : undefined;
}

export function getWindowsAudioPlayer(lookup: PathLookup = existsOnPath): string | undefined {
	for (const command of ["ffplay", "mpg123", "mpv"]) {
		if (lookup(command)) return command;
	}
	return undefined;
}

export function getAudioPlayerArgs(command: string, filePath: string): string[] {
	if (command === "ffplay") return ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath];
	if (command === "mpv") return ["--no-video", "--really-quiet", filePath];
	return [filePath];
}

function getPowerShellMediaPlayerInvocation(filePath: string): AudioPlayerInvocation {
	return {
		command: "powershell.exe",
		args: [
			"-NoProfile",
			"-Sta",
			"-Command",
			[
				"$ErrorActionPreference = 'Stop'",
				"$path = (Resolve-Path -LiteralPath $env:PK_SPEAK_AUDIO_PATH).Path",
				"Add-Type -AssemblyName PresentationCore",
				"$player = New-Object System.Windows.Media.MediaPlayer",
				"$player.Open([Uri]::new($path))",
				"$player.Play()",
				"$limit = (Get-Date).AddSeconds(120)",
				"while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $limit) { Start-Sleep -Milliseconds 50 }",
				"if ($player.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds) + 250) } else { Start-Sleep -Seconds 2 }",
				"$player.Close()",
			].join("; "),
		],
		env: { ...process.env, PK_SPEAK_AUDIO_PATH: filePath },
	};
}

export function getAudioPlayerInvocations(
	filePath: string,
	options: Pick<AudioPlaybackOptions, "allowOpenFallback"> = {},
	platform = currentPlatform(),
	lookup: PathLookup = existsOnPath,
): AudioPlayerInvocation[] {
	if (platform === "win32") {
		const player = getWindowsAudioPlayer(lookup);
		return [
			...(player ? [{ command: player, args: getAudioPlayerArgs(player, filePath) }] : []),
			getPowerShellMediaPlayerInvocation(filePath),
			...(options.allowOpenFallback ? [{ command: "cmd.exe", args: ["/c", "start", "", filePath] }] : []),
		];
	}
	const player = getUnixAudioPlayer(options.allowOpenFallback, lookup, platform);
	return player ? [{ command: player, args: getAudioPlayerArgs(player, filePath) }] : [];
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export async function terminateAudioChild(
	child: ChildProcess,
	platform = currentPlatform(),
	spawnCommand: SpawnCommand = spawn,
): Promise<void> {
	if (hasExited(child)) return;
	if (platform === "win32" && child.pid) {
		try {
			const taskkill = spawnCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
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
	}, PLAYER_KILL_GRACE_MS);
	escalation.unref();
}

async function waitForChild(child: ChildProcess, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		await terminateAudioChild(child);
		throw new Error("Audio playback cancelled.");
	}
	const cleanup = new AbortController();
	const close = once(child, "close", { signal: cleanup.signal }).then(([code]) => {
		if (code === 0) return;
		throw new Error(`Audio player exited with code ${code ?? "unknown"}`);
	});
	const failed = once(child, "error", { signal: cleanup.signal }).then(([error]) => {
		throw error;
	});
	const cancelled = signal
		? once(signal, "abort", { signal: cleanup.signal }).then(async () => {
			await terminateAudioChild(child);
			throw new Error("Audio playback cancelled.");
		})
		: undefined;
	try {
		await Promise.race([close, failed, ...(cancelled ? [cancelled] : [])]);
	} finally {
		cleanup.abort();
	}
}

async function playAudioFileAndWait(filePath: string, options: AudioPlaybackOptions, spawnCommand: SpawnCommand = spawn): Promise<AudioPlaybackResult> {
	const invocations = getAudioPlayerInvocations(filePath, options);
	if (invocations.length === 0) return "skipped";
	let lastError: Error | undefined;
	for (const invocation of invocations) {
		try {
			const child = spawnCommand(invocation.command, invocation.args, {
				stdio: "ignore",
				windowsHide: true,
				shell: false,
				env: invocation.env ?? process.env,
			});
			await waitForChild(child, options.signal);
			return invocation.command === "xdg-open" || invocation.command === "cmd.exe" ? "opened" : "played";
		} catch (error) {
			if (options.signal?.aborted) throw error;
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	if (currentPlatform() === "win32") return "skipped";
	throw lastError || new Error("Audio playback failed.");
}

export function buildPlaybackSupervisorArgs(filePath: string, options: AudioPlaybackOptions): string[] {
	const payload = Buffer.from(JSON.stringify({
		filePath,
		cleanupDir: options.cleanupDir,
		allowOpenFallback: options.allowOpenFallback === true,
	})).toString("base64url");
	return [fileURLToPath(import.meta.url), DETACHED_SUPERVISOR_FLAG, payload];
}

async function startPlaybackSupervisor(filePath: string, options: AudioPlaybackOptions, spawnCommand: SpawnCommand = spawn): Promise<AudioPlaybackResult> {
	const child = spawnCommand(process.execPath, buildPlaybackSupervisorArgs(filePath, options), {
		stdio: "ignore",
		detached: true,
		windowsHide: true,
		shell: false,
	});
	const cleanup = new AbortController();
	const started = once(child, "spawn", { signal: cleanup.signal });
	const failed = once(child, "error", { signal: cleanup.signal }).then(([error]) => {
		throw error;
	});
	try {
		await Promise.race([started, failed]);
	} finally {
		cleanup.abort();
	}
	child.unref();
	return "started";
}

/**
 * Plays a synthesized file. With wait:false, a detached Node supervisor owns
 * playback and cleanup so the caller may exit without deleting the file while
 * the player is still opening or reading it.
 */
export async function playAudioFile(filePath: string, options: AudioPlaybackOptions = {}): Promise<AudioPlaybackResult> {
	if (options.wait === false) return startPlaybackSupervisor(filePath, options);
	return playAudioFileAndWait(filePath, options);
}

async function supervisePlayback(encodedPayload: string): Promise<void> {
	const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
	const payload = JSON.parse(decoded) as {
		filePath?: string;
		cleanupDir?: string;
		allowOpenFallback?: boolean;
	};
	if (!payload.filePath) throw new Error("Playback supervisor received no audio path.");
	let canCleanup = true;
	try {
		const result = await playAudioFileAndWait(payload.filePath, { allowOpenFallback: payload.allowOpenFallback });
		// OS-default launchers return before the downstream app necessarily opens
		// the file. Keep the artifact rather than recreate the deletion race.
		canCleanup = result !== "opened";
	} finally {
		if (payload.cleanupDir && canCleanup) await rm(payload.cleanupDir, { recursive: true, force: true }).catch(() => {});
	}
}

function isRunningAsModuleEntry(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isRunningAsModuleEntry() && process.argv[2] === DETACHED_SUPERVISOR_FLAG) {
	void supervisePlayback(process.argv[3] || "").catch(() => {
		process.exitCode = 1;
	});
}
