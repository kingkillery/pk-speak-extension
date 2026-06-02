import { spawn } from "node:child_process";
import { platform } from "node:os";

export function getPlayerInvocation(filePath: string): { command: string; args: string[] } {
	if (platform() === "win32") {
		const escaped = filePath.replace(/\\/g, "\\\\").replace(/"/g, '`"').replace(/[$]/g, '`$');
		const ps = `
Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]::new("${escaped}"))
Start-Sleep -Milliseconds 250
$player.Play()
while ($player.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }
$duration = [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds)
Start-Sleep -Milliseconds ($duration + 1200)
$player.Stop()
$player.Close()
`;
		return { command: "powershell.exe", args: ["-NoProfile", "-Command", ps] };
	}
	if (platform() === "darwin") {
		return { command: "afplay", args: [filePath] };
	}
	return { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath] };
}

export function playAudio(filePath: string, options?: { wait?: boolean }): Promise<void> {
	const wait = options?.wait ?? true;
	const player = getPlayerInvocation(filePath);
	return new Promise<void>((resolve, reject) => {
		const child = spawn(player.command, player.args, {
			windowsHide: true,
			stdio: "ignore",
			shell: false,
			detached: !wait,
		});
		if (!wait) {
			child.on("error", () => {
				// Fire-and-forget: surface spawn errors only via the wait path.
			});
			try {
				child.unref();
			} catch {}
			resolve();
			return;
		}
		child.on("error", (error) => {
			reject(error);
		});
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Audio player exited with code ${code}`));
		});
	});
}
