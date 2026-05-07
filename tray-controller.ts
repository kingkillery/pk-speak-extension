import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import QRCode from "qrcode";

export type RemoteTrayOptions = {
	title: string;
	appSetupUrl: string;
	browserUrl: string;
	baseUrl: string;
	profileName: string;
};

export type RemoteTrayRuntime = {
	process: ChildProcess;
	htmlPath: string;
	scriptPath: string;
	configPath: string;
};

export async function startRemoteTray(options: RemoteTrayOptions): Promise<RemoteTrayRuntime | undefined> {
	if (process.platform !== "win32") return undefined;

	const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-tray-"));
	const htmlPath = join(tempDir, "pi-speak-setup.html");
	const scriptPath = join(tempDir, "pi-speak-tray.ps1");
	const configPath = join(tempDir, "pi-speak-tray.json");
	const qrSvg = await QRCode.toString(options.appSetupUrl, {
		type: "svg",
		errorCorrectionLevel: "M",
		margin: 2,
		width: 320,
	});

	writeFileSync(
		htmlPath,
		`<!doctype html>
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
<p>Scan this QR code with the Android phone to open Pi Speak and save this computer profile.</p>
<div class="qr">${qrSvg}</div>
<p class="meta"><strong>Profile:</strong> ${escapeHtml(options.profileName)}</p>
<p class="meta"><strong>Endpoint:</strong> <code>${escapeHtml(options.baseUrl)}</code></p>
</section>
</main>
</body>
</html>`,
		"utf8",
	);

	writeFileSync(configPath, JSON.stringify(options, null, 2), "utf8");
	writeFileSync(
		scriptPath,
		`
param([Parameter(Mandatory=$true)][string]$ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = $config.title
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$qrItem = New-Object System.Windows.Forms.ToolStripMenuItem
$qrItem.Text = "Show setup QR code"
$qrItem.Add_Click({ Start-Process -FilePath "${escapePowerShellPath(htmlPath)}" })
[void]$menu.Items.Add($qrItem)

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open web remote"
$openItem.Add_Click({ Start-Process -FilePath $config.browserUrl })
[void]$menu.Items.Add($openItem)

$copyItem = New-Object System.Windows.Forms.ToolStripMenuItem
$copyItem.Text = "Copy app setup link"
$copyItem.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($config.appSetupUrl) })
[void]$menu.Items.Add($copyItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit tray"
$exitItem.Add_Click({
	$notify.Visible = $false
	$notify.Dispose()
	[System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($exitItem)

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ Start-Process -FilePath "${escapePowerShellPath(htmlPath)}" })
[System.Windows.Forms.Application]::Run()
`,
		"utf8",
	);

	const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ConfigPath", configPath], {
		stdio: "ignore",
		detached: false,
		windowsHide: true,
	});
	return { process: child, htmlPath, scriptPath, configPath };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapePowerShellPath(value: string): string {
	return value.replace(/'/g, "''");
}
