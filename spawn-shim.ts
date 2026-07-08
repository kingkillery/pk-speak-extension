import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";

// Spawn a detached background process without shell interpretation.
//
// Callers resolve binaries that may be Windows npm shims (.cmd/.bat). Raw
// child_process.spawn requires `shell: true` to launch those on Windows, which
// then joins command + args into a single cmd.exe-parsed string with no
// per-argument escaping — letting shell metacharacters in remote-supplied
// values (e.g. a launch `prompt`) reach cmd.exe. cross-spawn resolves the shim
// and escapes arguments correctly, so no caller ever sets `shell: true`.
export function spawnDetached(command: string, args: string[], cwd: string): ChildProcess {
	return crossSpawn(command, args, {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: false,
	});
}
