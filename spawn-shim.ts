import crossSpawn from "cross-spawn";
import type { ChildProcess, SpawnOptions } from "node:child_process";

// Spawn without shell interpretation.
//
// Callers resolve binaries that may be Windows npm shims (.cmd/.bat). Raw
// child_process.spawn requires `shell: true` to launch those on Windows, which
// then joins command + args into a single cmd.exe-parsed string with no
// per-argument escaping — letting shell metacharacters in remote-supplied
// values (e.g. a launch/turn `prompt`) reach cmd.exe. cross-spawn resolves the
// shim and escapes arguments correctly, so no caller ever sets `shell: true`.
// `shell` is intentionally omitted from SpawnOptions here so a caller can't
// accidentally reintroduce the vulnerability by passing it through.
type SafeSpawnOptions = Omit<SpawnOptions, "shell">;

export function safeSpawn(command: string, args: string[], options: SafeSpawnOptions = {}): ChildProcess {
	return crossSpawn(command, args, options);
}

// Convenience wrapper for the common detached-background-launch case.
export function spawnDetached(command: string, args: string[], cwd: string): ChildProcess {
	return safeSpawn(command, args, {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: false,
	});
}
