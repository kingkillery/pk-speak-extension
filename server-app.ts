#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPiSpeakSetupConfig } from "./setup-config.js";
import { getOrCreateInstallAuthToken, pickPhoneFacingBaseUrl } from "./pairing.js";

applyPiSpeakSetupConfig();

/**
 * `pi-speak-server` — the one-command desktop entrypoint.
 *
 * Codex-app-style flow: run it (or double-click the installed shortcut) and it
 *   1. reuses the persistent install token (pairing survives restarts),
 *   2. starts the headless gateway unless one is already listening,
 *   3. waits for /health,
 *   4. opens the loopback-only /connect window (QR + live "phone connected"),
 *      as an Edge app window when available so it feels like a native app.
 *
 * Closing the window leaves the gateway running; use the tray or
 * scripts/gateway-autostart.ps1 to manage its lifetime.
 */

const DEFAULT_PORT = 8767;
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 500;

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || args.h) {
		console.log([
			"Usage: pi-speak-server [options]",
			"",
			"Starts the Pi Speak gateway (if needed) and opens the phone-connect window.",
			"",
			"Options:",
			"  --cwd <path>         Repo/runtime directory. Defaults to current directory.",
			"  --gateway <path>     Headless gateway entrypoint. Defaults to ./dist/headless-gateway.js.",
			"  --port <port>        Gateway HTTP port. Defaults to PI_SPEAK_HTTP_PORT or 8767.",
			"  --no-window          Do not open the connect window (print URLs only).",
			"  --install-shortcut   Install Desktop + Start Menu shortcuts (Windows).",
		].join("\n"));
		return;
	}

	const repoRoot = resolve(args.cwd || process.cwd());
	const gatewayEntry = resolve(args.gateway || join(repoRoot, "dist", "headless-gateway.js"));
	const port = Number.parseInt(args.port || process.env.PI_SPEAK_HTTP_PORT || "", 10) || DEFAULT_PORT;
	const token = process.env.PI_SPEAK_HTTP_TOKEN || getOrCreateInstallAuthToken();
	const connectUrl = `http://127.0.0.1:${port}/connect`;

	if (args.installShortcut || args["install-shortcut"]) {
		installShortcuts(repoRoot);
		console.log("Installed 'Pi Speak Server' shortcuts (Desktop + Start Menu).");
	}

	let attached = true;
	if (!(await isGatewayUp(port))) {
		attached = false;
		if (!existsSync(gatewayEntry)) {
			throw new Error(`Gateway build not found at ${gatewayEntry}. Run npm run build first or pass --gateway <path>.`);
		}
		const pid = spawnGateway(gatewayEntry, repoRoot, token, port);
		console.log(`Starting Pi Speak gateway (pid ${pid ?? "?"}) on port ${port}...`);
		const deadline = Date.now() + HEALTH_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await isGatewayUp(port)) break;
			await delay(HEALTH_POLL_MS);
		}
		if (!(await isGatewayUp(port))) {
			throw new Error(`Gateway did not become healthy on port ${port} within ${HEALTH_TIMEOUT_MS / 1000}s. Check the build and port.`);
		}
	}

	const phoneUrl = pickPhoneFacingBaseUrl(port);
	console.log(`Gateway: ${attached ? "already running" : "started"} on port ${port}`);
	console.log(`Phone URL: ${phoneUrl}`);
	console.log(`Connect window: ${connectUrl}`);

	if (args.noWindow || args["no-window"]) {
		console.log("Window suppressed (--no-window). Open the connect URL above to pair a phone.");
		return;
	}
	const mode = openConnectWindow(connectUrl);
	console.log(mode === "edge-app"
		? "Opened the connect window (Edge app mode). Scan the QR with your phone."
		: "Opened the connect page in your default browser. Scan the QR with your phone.");
}

function parseArgs(argv: string[]): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
		parsed[key] = value;
	}
	return parsed;
}

async function isGatewayUp(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return false;
		const body = (await res.json().catch(() => null)) as { app?: string } | null;
		return body?.app === "pi-speak";
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	const { promise, resolve: resolveDelay } = Promise.withResolvers<void>();
	setTimeout(resolveDelay, ms);
	return promise;
}

function spawnGateway(gatewayEntry: string, repoRoot: string, token: string, port: number): number | undefined {
	const child = spawn(process.execPath, [gatewayEntry], {
		cwd: repoRoot,
		env: {
			...process.env,
			PI_SPEAK_HTTP_TOKEN: token,
			PI_SPEAK_HTTP_PORT: String(port),
		},
		stdio: "ignore",
		detached: true,
		windowsHide: true,
	});
	child.on("error", () => {});
	child.unref();
	return child.pid;
}

function findEdgePath(): string | null {
	const candidates = [
		process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
		process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
	].filter((candidate): candidate is string => !!candidate);
	return candidates.find((candidate) => existsSync(candidate)) || null;
}

function openConnectWindow(url: string): "edge-app" | "default-browser" {
	if (process.platform === "win32") {
		const edge = findEdgePath();
		if (edge) {
			spawn(edge, [`--app=${url}`], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
			return "edge-app";
		}
		spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
		return "default-browser";
	}
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	return "default-browser";
}

function installShortcuts(repoRoot: string) {
	if (process.platform !== "win32") {
		console.error("--install-shortcut is Windows-only.");
		return;
	}
	const scriptPath = resolve(process.argv[1] || join(import.meta.dirname, "server-app.js"));
	const iconPath = [
		join(repoRoot, "assets", "pi-speak-tray.ico"),
		join(import.meta.dirname, "..", "assets", "pi-speak-tray.ico"),
	].find((candidate) => existsSync(candidate));
	const arguments_ = `"${scriptPath}" --cwd "${repoRoot}"`;
	const ps = `
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
	$shortcut = $shell.CreateShortcut((Join-Path $folder "Pi Speak Server.lnk"))
	$shortcut.TargetPath = ${psSingleQuote(process.execPath)}
	$shortcut.Arguments = ${psSingleQuote(arguments_)}
	$shortcut.WorkingDirectory = ${psSingleQuote(repoRoot)}
	${iconPath ? `$shortcut.IconLocation = ${psSingleQuote(iconPath)}` : ""}
	$shortcut.Save()
}
`;
	spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
		stdio: "ignore",
		windowsHide: true,
	}).on("error", () => {});
}

function psSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
