import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { defaultOhMyPiSessionRoots } from "./agent-hub-dashboard.js";

type ActiveBackgroundInstance = {
	name: string;
	status: "active";
	model?: string;
	role?: string;
};

export type ArchiveOhMyPiBackgroundSessionResult = {
	ok: boolean;
	message: string;
};

export function archiveOhMyPiBackgroundSession(sessionPath: string, env: NodeJS.ProcessEnv = process.env): ArchiveOhMyPiBackgroundSessionResult {
	const roots = defaultOhMyPiSessionRoots(env);
	const resolved = resolve(sessionPath);
	const inRoots = roots.some((root) => {
		const resolvedRoot = resolve(root);
		return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep);
	});
	if (!inRoots) {
		return { ok: false, message: "Session path is outside configured roots." };
	}

	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf8");
	} catch (error) {
		if (error instanceof Error) return { ok: false, message: `Session file is not readable: ${error.message}` };
		throw error;
	}

	const lines = raw.split(/\r?\n/);
	const header = parseRecord(lines[0] ?? "");
	if (!header || header.type !== "session") return { ok: false, message: "Session file is not an Oh-my-pi session." };

	const current = Object.prototype.hasOwnProperty.call(header, "backgroundInstance")
		? normalizeActiveBackgroundInstance(header.backgroundInstance)
		: findLatestActiveBackgroundInstance(lines);
	if (!current) return { ok: false, message: "Session is not an active Oh-my-pi background lane." };

	const archived = { ...current, status: "archived" };
	header.backgroundInstance = archived;
	lines[0] = JSON.stringify(header);
	const archivedEntry = {
		id: `pi-speak-archive-${Date.now()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "background_instance",
		...archived,
	};
	writeFileSync(sessionPath, `${lines.join("\n").replace(/\n*$/, "\n")}${JSON.stringify(archivedEntry)}\n`);
	return { ok: true, message: `Removed background session "${current.name}".` };
}

export function recoverOhMyPiBackgroundSession(sessionPath: string, env: NodeJS.ProcessEnv = process.env): ArchiveOhMyPiBackgroundSessionResult {
	const roots = defaultOhMyPiSessionRoots(env);
	const resolved = resolve(sessionPath);
	const inRoots = roots.some((root) => {
		const resolvedRoot = resolve(root);
		return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep);
	});
	if (!inRoots) {
		return { ok: false, message: "Session path is outside configured roots." };
	}

	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf8");
	} catch (error) {
		if (error instanceof Error) return { ok: false, message: `Session file is not readable: ${error.message}` };
		throw error;
	}

	const lines = raw.split(/\r?\n/);
	const header = parseRecord(lines[0] ?? "");
	if (!header || header.type !== "session") return { ok: false, message: "Session file is not an Oh-my-pi session." };

	const archived = Object.prototype.hasOwnProperty.call(header, "backgroundInstance")
		? normalizeArchivedBackgroundInstance(header.backgroundInstance)
		: findLatestArchivedBackgroundInstance(lines);
	if (!archived) return { ok: false, message: "Session is not an archived Oh-my-pi background lane." };

	const active = { ...archived, status: "active" as const };
	header.backgroundInstance = active;
	lines[0] = JSON.stringify(header);
	const recoveredEntry = {
		id: `pi-speak-recover-${Date.now()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "background_instance",
		...active,
	};
	writeFileSync(sessionPath, `${lines.join("\n").replace(/\n*$/, "\n")}${JSON.stringify(recoveredEntry)}\n`);
	return { ok: true, message: `Recovered background session "${active.name}".` };
}

function findLatestArchivedBackgroundInstance(lines: string[]): ActiveBackgroundInstance | undefined {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const record = parseRecord(lines[index]);
		if (record?.type !== "background_instance") continue;
		const archived = normalizeArchivedBackgroundInstance(record);
		if (archived) return archived;
	}
	return undefined;
}

function normalizeArchivedBackgroundInstance(value: unknown): ActiveBackgroundInstance | undefined {
	if (!isRecord(value) || value.status !== "archived" || typeof value.name !== "string") return undefined;
	return {
		name: value.name,
		status: "active",
		model: typeof value.model === "string" ? value.model : undefined,
		role: typeof value.role === "string" ? value.role : undefined,
	};
}

function findLatestActiveBackgroundInstance(lines: string[]): ActiveBackgroundInstance | undefined {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const record = parseRecord(lines[index]);
		if (record?.type !== "background_instance") continue;
		return normalizeActiveBackgroundInstance(record);
	}
	return undefined;
}

function normalizeActiveBackgroundInstance(value: unknown): ActiveBackgroundInstance | undefined {
	if (!isRecord(value) || value.status !== "active" || typeof value.name !== "string") return undefined;
	return {
		name: value.name,
		status: "active",
		model: typeof value.model === "string" ? value.model : undefined,
		role: typeof value.role === "string" ? value.role : undefined,
	};
}

function parseRecord(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	return isRecord(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type OhMyPiLaunchOptions = {
	cwd?: string;
	prompt?: string;
	model?: string;
	provider?: string;
	sessionDir?: string;
	hubOnly?: boolean;
};

export type OhMyPiLaunchArgvResult =
	| { ok: true; argv: string[]; cwd: string; mode: "launch" | "hub" }
	| { ok: false; message: string };

const MAX_PROMPT_LENGTH = 4096;
const MAX_MODEL_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;
const MAX_CWD_LENGTH = 1024;
const NUL_CHAR_CODE = 0;

function hasControlOrNul(value: string): boolean {
	if (value.indexOf(String.fromCharCode(NUL_CHAR_CODE)) !== -1) return true;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if ((code >= 1 && code <= 31) || code === 127) return true;
	}
	return false;
}

function isSafeSingleToken(value: string): boolean {
	if (value.length === 0) return false;
	if (hasControlOrNul(value)) return false;
	// Reject any whitespace (not just leading/trailing) so model/provider
	// identifiers like "gpt 5" or "claude\nsonnet" are rejected.
	for (let index = 0; index < value.length; index += 1) {
		if (WHITESPACE_CHAR_CODES.has(value.charCodeAt(index))) return false;
	}
	return true;
}
const WHITESPACE_CHAR_CODES = new Set<number>([9, 10, 11, 12, 13, 32]);

function normalizeOptionalString(
	value: unknown,
	max: number,
	field: string,
): string | undefined | { error: string } {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return { error: `Invalid ${field}: must be a string.` };
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.length > max) return { error: `Invalid ${field}: exceeds ${max} characters.` };
	if (hasControlOrNul(trimmed)) return { error: `Invalid ${field}: contains control or NUL bytes.` };
	return trimmed;
}

export function buildOhMyPiLaunchArgv(
	options: OhMyPiLaunchOptions,
	fallbackCwd: string,
): OhMyPiLaunchArgvResult {
	const cwdNormalized = normalizeOptionalString(options.cwd, MAX_CWD_LENGTH, "cwd");
	if (cwdNormalized && typeof cwdNormalized === "object" && "error" in cwdNormalized) {
		return { ok: false, message: cwdNormalized.error };
	}
	const cwd = resolve(cwdNormalized ?? fallbackCwd);

	if (options.hubOnly) {
		return { ok: true, argv: ["bg"], cwd, mode: "hub" };
	}

	const sessionDir = normalizeOptionalString(options.sessionDir, MAX_PATH_LENGTH, "sessionDir");
	if (sessionDir && typeof sessionDir === "object" && "error" in sessionDir) {
		return { ok: false, message: sessionDir.error };
	}

	const prompt = normalizeOptionalString(options.prompt, MAX_PROMPT_LENGTH, "prompt");
	if (prompt && typeof prompt === "object" && "error" in prompt) {
		return { ok: false, message: prompt.error };
	}

	const argv: string[] = ["--cwd", cwd];
	if (sessionDir) argv.push("--session-dir", sessionDir);

	if (typeof options.model === "string" && options.model.trim().length > 0) {
		const model = options.model.trim();
		if (model.length > MAX_MODEL_LENGTH) {
			return { ok: false, message: `Invalid model: exceeds ${MAX_MODEL_LENGTH} characters.` };
		}
		if (!isSafeSingleToken(model)) {
			return { ok: false, message: "Invalid model: must not contain whitespace or control bytes." };
		}
		argv.push("--model", model);
	}

	if (typeof options.provider === "string" && options.provider.trim().length > 0) {
		const provider = options.provider.trim();
		if (provider.length > MAX_PROVIDER_LENGTH) {
			return { ok: false, message: `Invalid provider: exceeds ${MAX_PROVIDER_LENGTH} characters.` };
		}
		if (!isSafeSingleToken(provider)) {
			return { ok: false, message: "Invalid provider: must not contain whitespace or control bytes." };
		}
		argv.push("--provider", provider);
	}

	if (prompt) argv.push("--", prompt);

	return { ok: true, argv, cwd, mode: "launch" };
}
