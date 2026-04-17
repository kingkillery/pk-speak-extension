import type { ChildProcess } from "node:child_process";

export type ShutdownTarget = Pick<ChildProcess, "stdin" | "killed" | "kill" | "on">;

export type GracefulShutdownOptions = {
	command?: string;
	killAfterMs?: number;
};

export function requestGracefulChildShutdown(
	proc: ShutdownTarget | undefined,
	options: GracefulShutdownOptions = {},
): NodeJS.Timeout | undefined {
	if (!proc || proc.killed) return undefined;
	const command = options.command ?? "shutdown";
	const killAfterMs = options.killAfterMs ?? 3000;

	try {
		if (command) proc.stdin?.write?.(`${command}\n`);
	} catch {}
	try {
		proc.stdin?.end?.();
	} catch {}

	const timer = setTimeout(() => {
		if (!proc.killed) {
			try { proc.kill(); } catch {}
		}
	}, killAfterMs);
	proc.on?.("exit", () => clearTimeout(timer));
	return timer;
}
