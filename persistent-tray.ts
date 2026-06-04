#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import { applyPiSpeakSetupConfig } from "./setup-config.js";

applyPiSpeakSetupConfig();

type TrayConfig = {
	title: string;
	appSetupUrl: string;
	setupPageUrl: string;
	downloadUrl: string;
	statusUrl: string;
	browserUrl: string;
	baseUrl: string;
	profileName: string;
	cwd: string;
	command: string;
	args: string[];
	trayCommand: string;
	trayArgs: string[];
	env: Record<string, string>;
	htmlPath: string;
	logPath: string;
	childLogPath: string;
	iconPath: string;
};

const DEFAULT_BASE_URL = "http://100.76.136.91:8767/";
const DEFAULT_PROFILE_NAME = "MSI / appserver";
const DEFAULT_PORT = 8767;
const TAILSCALE_APPSERVER_IP = "100.76.136.91";
const TAILSCALE_MAC_IP = "100.76.176.119";

async function main() {
	if (process.platform !== "win32") {
		console.error("pi-speak-tray is currently Windows-only.");
		process.exitCode = 1;
		return;
	}

	const args = parseArgs(process.argv.slice(2));
	if (args.help || args.h) {
		console.log([
			"Usage: pi-speak-tray [options]",
			"",
			"Starts a Windows tray icon that owns the Pi Speak remote gateway.",
			"The gateway is restarted while the tray is open and stopped when you exit the tray.",
			"",
			"Options:",
			"  --base-url <url>       Phone-facing base URL. Defaults to http://100.76.136.91:8767/",
			"  --token <token>        Remote auth token. Defaults to PI_SPEAK_HTTP_TOKEN or a generated per-run token.",
			"  --cwd <path>           Repo/runtime directory. Defaults to current directory.",
			"  --gateway <path>       Headless gateway entrypoint. Defaults to ./dist/headless-gateway.js.",
			"  --profile-name <name>  Android profile name. Defaults to MSI / appserver.",
			"  --icon <path>          Tray .ico path. Defaults to assets/pi-speak-tray.ico when present.",
			"  --install-startup      Install a Windows startup shortcut for the tray.",
		].join("\n"));
		return;
	}
	const repoRoot = resolve(args.cwd || process.cwd());
	const gatewayEntry = resolve(args.gateway || join(repoRoot, "dist", "headless-gateway.js"));
	if (!existsSync(gatewayEntry)) {
		throw new Error(`Pi Speak headless gateway build not found at ${gatewayEntry}. Run npm run build first or pass --gateway <path>.`);
	}

	const baseUrlArg = args.baseUrl || args["base-url"];
	const profileNameArg = args.profileName || args["profile-name"];
	const baseUrl = normalizeBaseUrl(baseUrlArg || process.env.PI_SPEAK_TRAY_BASE_URL || process.env.PI_SPEAK_PUBLIC_BASE_URL || getDefaultBaseUrl());
	const token = args.token || process.env.PI_SPEAK_HTTP_TOKEN || randomToken();
	const profileName = profileNameArg || DEFAULT_PROFILE_NAME;
	const iconPath = resolveTrayIconPath(repoRoot, args.icon || process.env.PI_SPEAK_TRAY_ICON);
	const appSetupUrl = buildAppSetupUrl(baseUrl, token, profileName);
	const setupPageUrl = new URL(`setup?token=${encodeURIComponent(token)}&profile_name=${encodeURIComponent(profileName)}`, baseUrl).toString();
	const downloadUrl = new URL("download/pi-speak.apk", baseUrl).toString();
	const statusUrl = new URL("v1/diagnostics", baseUrl).toString();
	const browserUrl = new URL("app/", baseUrl).toString();
	const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-persistent-tray-"));
	const htmlPath = join(tempDir, "pi-speak-setup.html");
	const logPath = join(tempDir, "pi-speak-tray.log");
	const childLogPath = join(tempDir, "pi-speak-remote.log");
	const scriptPath = join(tempDir, "pi-speak-persistent-tray.ps1");
	const configPath = join(tempDir, "pi-speak-persistent-tray.json");

	const qrSvg = await QRCode.toString(setupPageUrl, {
		type: "svg",
		errorCorrectionLevel: "M",
		margin: 2,
		width: 320,
	});
	writeFileSync(htmlPath, renderSetupHtml({ profileName, baseUrl, setupPageUrl, downloadUrl, appSetupUrl, qrSvg }), "utf8");

	const config: TrayConfig = {
		title: `Pi Speak - ${profileName}`,
		appSetupUrl,
		setupPageUrl,
		downloadUrl,
		statusUrl,
		browserUrl,
		baseUrl,
		profileName,
		cwd: repoRoot,
		command: process.execPath,
		args: [gatewayEntry],
		trayCommand: process.execPath,
		trayArgs: [
			resolve(process.argv[1] || join(import.meta.dirname, "persistent-tray.js")),
			"--cwd",
			repoRoot,
			"--gateway",
			gatewayEntry,
			...(iconPath ? ["--icon", iconPath] : []),
		],
		env: {
			PI_SPEAK_HTTP_TOKEN: token,
			PI_SPEAK_TRAY: "0",
		},
		htmlPath,
		logPath,
		childLogPath,
		iconPath,
	};
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
	writeFileSync(scriptPath, renderTrayScript(), "utf8");

	const launchScript = [
		`$argsList = @(${[
			"-NoProfile",
			"-STA",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath,
			"-ConfigPath",
			configPath,
		].map((value) => psSingleQuote(value)).join(", ")});`,
		"Start-Process -FilePath 'powershell.exe' -ArgumentList $argsList -WindowStyle Hidden",
	].join(" ");
	const child = spawn("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		launchScript,
	], {
		stdio: "ignore",
		detached: false,
		windowsHide: true,
	});
	child.on("error", () => {});
	console.log(`Pi Speak tray started for ${baseUrl}`);
	if (args.installStartup || args["install-startup"]) {
		installStartupShortcut({ repoRoot, gatewayEntry, baseUrl, token, profileName, iconPath });
	}
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

function findDistIndex(repoRoot: string): string {
	const local = join(repoRoot, "dist", "index.js");
	if (existsSync(local)) return local;
	const fromDist = join(dirname(resolve(process.argv[1] || ".")), "index.js");
	return fromDist;
}

function normalizeBaseUrl(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function isPrivateLanIpv4(address: string) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailscaleIpv4(address: string) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function getDefaultBaseUrl() {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries || []) {
			if (entry.family === "IPv4" && !entry.internal && isTailscaleIpv4(entry.address)) {
				return `http://${entry.address}:${DEFAULT_PORT}/`;
			}
		}
	}
	const fallback = platform() === "darwin" ? TAILSCALE_MAC_IP : TAILSCALE_APPSERVER_IP;
	return DEFAULT_BASE_URL.replace(TAILSCALE_APPSERVER_IP, fallback);
}

function resolveTrayIconPath(repoRoot: string, configured?: string): string {
	if (configured?.trim()) return resolve(configured.trim());
	const candidates = [
		join(repoRoot, "assets", "pi-speak-tray.ico"),
		join(dirname(resolve(process.argv[1] || ".")), "..", "assets", "pi-speak-tray.ico"),
		join(dirname(resolve(process.argv[1] || ".")), "assets", "pi-speak-tray.ico"),
	];
	return candidates.find((candidate) => existsSync(candidate)) || "";
}

function randomToken(): string {
	return randomBytes(24).toString("base64url");
}

function buildAppSetupUrl(baseUrl: string, token: string, profileName: string): string {
	const params = new URLSearchParams({
		base_url: baseUrl,
		token,
		machine_id: "tailscale-appserver",
		profile_name: profileName,
		connection_mode: "tailscale",
	});
	return `pi-speak://setup?${params.toString()}`;
}

function renderSetupHtml({
	profileName,
	baseUrl,
	setupPageUrl,
	downloadUrl,
	appSetupUrl,
	qrSvg,
}: {
	profileName: string;
	baseUrl: string;
	setupPageUrl: string;
	downloadUrl: string;
	appSetupUrl: string;
	qrSvg: string;
}): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Pi Speak Setup</title>
<style>
body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #f7f9fc; color: #111827; }
main { max-width: 560px; margin: 0 auto; padding: 32px; }
.panel { background: white; border: 1px solid #d8dee9; border-radius: 10px; padding: 24px; box-shadow: 0 14px 40px rgba(15, 23, 42, 0.12); }
.qr { display: flex; justify-content: center; margin: 18px 0; }
.meta { font-size: 14px; color: #475569; overflow-wrap: anywhere; }
code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
</style>
</head>
<body>
<main>
<section class="panel">
<h1>Pi Speak setup</h1>
<p>Scan this QR code with the Android phone. It opens the setup page served by the tray service, where you can download the APK and connect this machine.</p>
<div class="qr">${qrSvg}</div>
<p class="meta"><strong>Profile:</strong> ${escapeHtml(profileName)}</p>
<p class="meta"><strong>Endpoint:</strong> <code>${escapeHtml(baseUrl)}</code></p>
<p class="meta"><strong>Setup page:</strong> <code>${escapeHtml(setupPageUrl)}</code></p>
<p class="meta"><strong>APK:</strong> <code>${escapeHtml(downloadUrl)}</code></p>
<p class="meta"><strong>Native link:</strong> <code>${escapeHtml(appSetupUrl)}</code></p>
</section>
</main>
</body>
</html>`;
}

function installStartupShortcut({
	repoRoot,
	gatewayEntry,
	baseUrl,
	token,
	profileName,
	iconPath,
}: {
	repoRoot: string;
	gatewayEntry: string;
	baseUrl: string;
	token: string;
	profileName: string;
	iconPath: string;
}) {
	const scriptPath = resolve(process.argv[1] || join(import.meta.dirname, "persistent-tray.js"));
	const ps = `
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Pi Speak Tray.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = ${psSingleQuote(process.execPath)}
$shortcut.Arguments = ${psSingleQuote([
	scriptPath,
	"--cwd",
	repoRoot,
	"--gateway",
	gatewayEntry,
	"--base-url",
	baseUrl,
	"--token",
	token,
	"--profile-name",
	profileName,
	...(iconPath ? ["--icon", iconPath] : []),
].map((value) => `"${value.replace(/"/g, '\\"')}"`).join(" "))}
$shortcut.WorkingDirectory = ${psSingleQuote(repoRoot)}
$shortcut.Save()
`;
	spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
		stdio: "ignore",
		detached: false,
		windowsHide: true,
	}).on("error", () => {});
}

function renderTrayScript(): string {
	return `
param([Parameter(Mandatory=$true)][string]$ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
function Write-TrayLog([string]$Message) {
	try {
		$line = "[" + (Get-Date).ToString("s") + "] " + $Message
		Add-Content -LiteralPath $config.logPath -Value $line
	} catch {}
}
Write-TrayLog "Tray script starting"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = $config.title
if ($config.iconPath -and (Test-Path -LiteralPath $config.iconPath)) {
	try {
		$notify.Icon = New-Object System.Drawing.Icon($config.iconPath)
		Write-TrayLog ("Loaded tray icon " + $config.iconPath)
	} catch {
		Write-TrayLog ("Failed to load tray icon: " + $_.Exception.Message)
		$notify.Icon = [System.Drawing.SystemIcons]::Application
	}
} else {
	$notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$remoteProcess = $null
$usingExistingGateway = $false
$keepGatewayOnExit = $false

function Test-GatewayListening {
	try {
		$conn = Get-NetTCPConnection -LocalPort 8767 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
		return $null -ne $conn
	} catch {
		return $false
	}
}

function Start-Remote {
	if ($script:remoteProcess -and -not $script:remoteProcess.HasExited) { return }
	if (Test-GatewayListening) {
		if (-not $script:usingExistingGateway) {
			Write-TrayLog "Using existing remote gateway on port 8767"
		}
		$script:usingExistingGateway = $true
		$notify.Text = $config.title + " (existing)"
		return
	}
	$script:usingExistingGateway = $false
	Write-TrayLog "Starting remote gateway"
	$oldToken = [Environment]::GetEnvironmentVariable("PI_SPEAK_HTTP_TOKEN", "Process")
	$oldTray = [Environment]::GetEnvironmentVariable("PI_SPEAK_TRAY", "Process")
	foreach ($prop in $config.env.PSObject.Properties) {
		[Environment]::SetEnvironmentVariable($prop.Name, [string]$prop.Value, "Process")
	}
	try {
		$script:remoteProcess = Start-Process -FilePath $config.command -ArgumentList ([string[]]$config.args) -WorkingDirectory $config.cwd -WindowStyle Hidden -PassThru
		$notify.Text = $config.title + " (running)"
		Write-TrayLog ("Remote gateway started pid=" + $script:remoteProcess.Id)
	} catch {
		Write-TrayLog ("Failed to start remote gateway: " + $_.Exception.Message)
	} finally {
		[Environment]::SetEnvironmentVariable("PI_SPEAK_HTTP_TOKEN", $oldToken, "Process")
		[Environment]::SetEnvironmentVariable("PI_SPEAK_TRAY", $oldTray, "Process")
	}
}

function Stop-Remote {
	if ($script:usingExistingGateway) {
		Write-TrayLog "Leaving existing remote gateway running"
		$script:usingExistingGateway = $false
		return
	}
	if ($script:remoteProcess -and -not $script:remoteProcess.HasExited) {
		Write-TrayLog ("Stopping remote gateway pid=" + $script:remoteProcess.Id)
		try { Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID", $script:remoteProcess.Id, "/T", "/F" -WindowStyle Hidden -Wait } catch {}
	}
	$script:remoteProcess = $null
}

function Show-Status {
	$state = if ($script:usingExistingGateway) { "using existing gateway" } elseif ($script:remoteProcess -and -not $script:remoteProcess.HasExited) { "running pid=" + $script:remoteProcess.Id } else { "starting or stopped" }
	$message = "Pi Speak tray service: " + $state + [Environment]::NewLine +
		"Endpoint: " + $config.baseUrl + [Environment]::NewLine +
		"Profile: " + $config.profileName + [Environment]::NewLine +
		"Setup page: " + $config.setupPageUrl + [Environment]::NewLine +
		"Diagnostics: " + $config.statusUrl + [Environment]::NewLine +
		"Log: " + $config.logPath
	[System.Windows.Forms.MessageBox]::Show($message, "Pi Speak status", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}

function Restart-TrayWithSettings {
	$newBaseUrl = [Microsoft.VisualBasic.Interaction]::InputBox("Phone-facing base URL. Use the Tailscale URL when available.", "Pi Speak settings", $config.baseUrl)
	if ([string]::IsNullOrWhiteSpace($newBaseUrl)) { return }
	$newProfile = [Microsoft.VisualBasic.Interaction]::InputBox("Profile name shown on the Android phone.", "Pi Speak settings", $config.profileName)
	if ([string]::IsNullOrWhiteSpace($newProfile)) { $newProfile = $config.profileName }
	$currentToken = [string]$config.env.PI_SPEAK_HTTP_TOKEN
	$newToken = [Microsoft.VisualBasic.Interaction]::InputBox("Remote token. Leave the existing token unless you are rotating access.", "Pi Speak settings", $currentToken)
	if ([string]::IsNullOrWhiteSpace($newToken)) { $newToken = $currentToken }
	$args = [System.Collections.Generic.List[string]]::new()
	foreach ($arg in $config.trayArgs) { [void]$args.Add([string]$arg) }
	[void]$args.Add("--base-url"); [void]$args.Add($newBaseUrl)
	[void]$args.Add("--profile-name"); [void]$args.Add($newProfile)
	[void]$args.Add("--token"); [void]$args.Add($newToken)
	if ($config.iconPath) { [void]$args.Add("--icon"); [void]$args.Add([string]$config.iconPath) }
	Write-TrayLog "Restarting tray with updated settings"
	Start-Process -FilePath $config.trayCommand -ArgumentList $args.ToArray() -WorkingDirectory $config.cwd -WindowStyle Hidden
	Stop-Remote
	$notify.Visible = $false
	$notify.Dispose()
	[System.Windows.Forms.Application]::Exit()
}

$qrItem = New-Object System.Windows.Forms.ToolStripMenuItem
$qrItem.Text = "Show phone setup"
$qrItem.Add_Click({ Start-Process -FilePath $config.htmlPath })
[void]$menu.Items.Add($qrItem)

$setupItem = New-Object System.Windows.Forms.ToolStripMenuItem
$setupItem.Text = "Open setup page"
$setupItem.Add_Click({ Start-Process -FilePath $config.setupPageUrl })
[void]$menu.Items.Add($setupItem)

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open web remote"
$openItem.Add_Click({ Start-Process -FilePath $config.browserUrl })
[void]$menu.Items.Add($openItem)

$downloadItem = New-Object System.Windows.Forms.ToolStripMenuItem
$downloadItem.Text = "Open Android APK download"
$downloadItem.Add_Click({ Start-Process -FilePath $config.downloadUrl })
[void]$menu.Items.Add($downloadItem)

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = "Status"
$statusItem.Add_Click({ Show-Status })
[void]$menu.Items.Add($statusItem)

$settingsItem = New-Object System.Windows.Forms.ToolStripMenuItem
$settingsItem.Text = "Settings..."
$settingsItem.Add_Click({ Restart-TrayWithSettings })
[void]$menu.Items.Add($settingsItem)

$copyItem = New-Object System.Windows.Forms.ToolStripMenuItem
$copyItem.Text = "Copy setup page link"
$copyItem.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($config.setupPageUrl) })
[void]$menu.Items.Add($copyItem)

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem.Text = "Restart remote gateway"
$restartItem.Add_Click({ Stop-Remote; Start-Remote })
[void]$menu.Items.Add($restartItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$keepExitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$keepExitItem.Text = "Exit tray, keep gateway running"
$keepExitItem.Add_Click({
	$script:keepGatewayOnExit = $true
	$notify.Visible = $false
	$notify.Dispose()
	[System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($keepExitItem)

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit tray and stop remote"
$exitItem.Add_Click({
	Stop-Remote
	$notify.Visible = $false
	$notify.Dispose()
	[System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($exitItem)

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ Start-Process -FilePath $config.htmlPath })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
	if ($script:usingExistingGateway -and (Test-GatewayListening)) {
		return
	}
	if (-not $script:remoteProcess -or $script:remoteProcess.HasExited) {
		if ($script:remoteProcess -and $script:remoteProcess.HasExited) {
			Write-TrayLog ("Remote gateway exited code=" + $script:remoteProcess.ExitCode)
		}
		Start-Remote
	}
})
$timer.Start()
Start-Remote
[System.Windows.Forms.Application]::Run()
if (-not $script:keepGatewayOnExit) { Stop-Remote }
`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function psSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
