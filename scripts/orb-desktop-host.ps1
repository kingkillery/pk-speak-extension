param(
	[Parameter(Mandatory = $true)][string]$Url,
	[string]$BrowserPath = "",
	[int]$Width = 420,
	[int]$Height = 720,
	[int]$Margin = 24,
	[switch]$NoTopMost
)

$ErrorActionPreference = "Stop"

function Get-EdgePath {
	$candidates = @()
	$pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
	if ($pf86) { $candidates += (Join-Path $pf86 "Microsoft\Edge\Application\msedge.exe") }
	if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe") }
	if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe") }
	foreach ($candidate in $candidates) {
		if (Test-Path -LiteralPath $candidate) { return $candidate }
	}
	return $null
}

function Get-ChromePath {
	$candidates = @()
	if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe") }
	$pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
	if ($pf86) { $candidates += (Join-Path $pf86 "Google\Chrome\Application\chrome.exe") }
	if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe") }
	foreach ($candidate in $candidates) {
		if (Test-Path -LiteralPath $candidate) { return $candidate }
	}
	return $null
}

function Test-SupportsAppMode([string]$Path) {
	if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
	$name = [System.IO.Path]::GetFileName($Path).ToLowerInvariant()
	$full = $Path.ToLowerInvariant()
	return @(
		$name -eq "msedge.exe" -or
		$name -eq "chrome.exe" -or
		$name -eq "brave.exe" -or
		$name -eq "comet.exe" -or
		$full -match "chrome" -or
		$full -match "msedge" -or
		$full -match "brave" -or
		$full -match "comet" -or
		$full -match "chromium" -or
		$full -match "vivaldi" -or
		$full -match "opera"
	)
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OrbWindowHost {
	public const int GWL_EXSTYLE = -20;
	public const int WS_EX_TOOLWINDOW = 0x00000080;
	public const int WS_EX_APPWINDOW = 0x00040000;
	public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
	public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
	public const uint SWP_FRAMECHANGED = 0x0020;
	public const uint SWP_SHOWWINDOW = 0x0040;

	public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

	[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
	[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
	[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
	[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
	[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
	[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

	public static List<IntPtr> FindProcessWindows(uint pid) {
		var matches = new List<IntPtr>();
		EnumWindows((hWnd, lParam) => {
			if (!IsWindowVisible(hWnd)) return true;
			uint windowPid;
			GetWindowThreadProcessId(hWnd, out windowPid);
			if (windowPid == pid) matches.Add(hWnd);
			return true;
		}, IntPtr.Zero);
		return matches;
	}

	public static string GetTitle(IntPtr hWnd) {
		var sb = new StringBuilder(512);
		GetWindowText(hWnd, sb, sb.Capacity);
		return sb.ToString();
	}

	public static void StyleAsCompanion(IntPtr hWnd, bool topMost, int x, int y, int width, int height) {
		// Keep caption + thick frame so the operator can still drag/resize.
		// Chromium app-mode does not honor Electron-style -webkit-app-region.
		int ex = GetWindowLong(hWnd, GWL_EXSTYLE);
		ex |= WS_EX_TOOLWINDOW;
		ex &= ~WS_EX_APPWINDOW;
		SetWindowLong(hWnd, GWL_EXSTYLE, ex);

		var z = topMost ? HWND_TOPMOST : HWND_NOTOPMOST;
		SetWindowPos(hWnd, z, x, y, width, height, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
		ShowWindow(hWnd, 5); // SW_SHOW
	}
}
"@

# Resolve an explicit Chromium executable. Never launch via shell association —
# default-browser handlers can reuse an existing process and break HWND pinning.
$browser = $null
if ($BrowserPath -and (Test-Path -LiteralPath $BrowserPath) -and (Test-SupportsAppMode $BrowserPath)) {
	$browser = $BrowserPath
}
if (-not $browser) {
	$cometCandidates = @()
	if ($env:LOCALAPPDATA) {
		$cometCandidates += (Join-Path $env:LOCALAPPDATA "Perplexity\Comet\Application\comet.exe")
		$cometCandidates += (Join-Path $env:LOCALAPPDATA "Comet\Application\comet.exe")
	}
	if ($env:ProgramFiles) {
		$cometCandidates += (Join-Path $env:ProgramFiles "Perplexity\Comet\Application\comet.exe")
		$cometCandidates += (Join-Path $env:ProgramFiles "Comet\Application\comet.exe")
	}
	foreach ($candidate in $cometCandidates) {
		if (Test-Path -LiteralPath $candidate) { $browser = $candidate; break }
	}
}
if (-not $browser) { $browser = Get-ChromePath }
if (-not $browser) { $browser = Get-EdgePath }
if (-not $browser) {
	Write-Error "No Chromium app-mode browser found (Comet/Chrome/Edge). Use default-browser tab fallback instead of floating host."
	exit 1
}
if (-not (Test-SupportsAppMode $browser)) {
	Write-Error "Browser does not support --app companion mode: $browser"
	exit 1
}

# Isolated profile so we always get a fresh process/HWND we can pin.
$browserName = [System.IO.Path]::GetFileNameWithoutExtension($browser)
$profileDir = Join-Path $env:LOCALAPPDATA ("PiSpeak\OrbCompanionProfile-" + $browserName)
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$browserArgs = @(
	"--app=$Url",
	"--user-data-dir=$profileDir",
	"--window-size=$Width,$Height",
	"--disable-features=TranslateUI",
	"--no-first-run",
	"--no-default-browser-check"
)

$proc = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru
if (-not $proc) {
	Write-Error "Failed to start app-mode orb via $browser"
	exit 1
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = [Math]::Max($Margin, $screen.Right - $Width - $Margin)
$y = [Math]::Max($Margin, $screen.Bottom - $Height - $Margin)

$deadline = (Get-Date).AddSeconds(12)
$target = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $target -eq [IntPtr]::Zero) {
	Start-Sleep -Milliseconds 200
	try { $proc.Refresh() } catch {}
	if ($proc.HasExited) { break }
	$windows = [OrbWindowHost]::FindProcessWindows([uint32]$proc.Id)
	foreach ($hwnd in $windows) {
		$title = [OrbWindowHost]::GetTitle($hwnd)
		if ([string]::IsNullOrWhiteSpace($title)) { continue }
		if ($title -match "Pi Speak" -or $title -match "orb" -or $windows.Count -eq 1) {
			$target = $hwnd
			break
		}
	}
	if ($target -eq [IntPtr]::Zero -and $windows.Count -gt 0) {
		$target = $windows[0]
	}
}

if ($target -eq [IntPtr]::Zero) {
	Write-Warning ("Launched app-mode orb via {0} but could not locate window to pin." -f $browser)
	exit 0
}

[OrbWindowHost]::StyleAsCompanion($target, (-not $NoTopMost.IsPresent), $x, $y, $Width, $Height)
Write-Output ("Pinned floating orb browser={0} hwnd={1} pid={2} bounds={3}x{4}+{5}+{6}" -f $browser, $target, $proc.Id, $Width, $Height, $x, $y)
exit 0
