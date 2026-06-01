import { closeSync, openSync, readSync } from "node:fs";

export function readSessionWorkingDirectory(sessionPath: string | undefined): string | undefined {
	if (!sessionPath) return undefined;
	const firstLine = readFileFirstLine(sessionPath, 128 * 1024);
	if (!firstLine) return undefined;
	try {
		const parsed = JSON.parse(firstLine);
		const cwd = stringValue(parsed?.payload?.cwd) || stringValue(parsed?.cwd);
		return cwd || undefined;
	} catch {
		return undefined;
	}
}

export function buildSessionWorkingDirectoryMap(
	sessionPaths: Iterable<string | undefined>,
	fallbacks: Record<string, string | undefined> = {},
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const sessionPath of sessionPaths) {
		if (!sessionPath || result[sessionPath]) continue;
		const cwd = fallbacks[sessionPath] || readSessionWorkingDirectory(sessionPath);
		if (cwd) result[sessionPath] = cwd;
	}
	return result;
}

function readFileFirstLine(path: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(maxBytes);
		const bytes = readSync(fd, buffer, 0, maxBytes, 0);
		const prefix = buffer.subarray(0, bytes).toString("utf8");
		const newline = prefix.indexOf("\n");
		return (newline >= 0 ? prefix.slice(0, newline) : prefix).trim();
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
	}
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
