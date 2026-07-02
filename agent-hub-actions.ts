import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export type OmpSelectionValidation = { ok: true } | { ok: false; error: string };

// Single source of truth for whether an omp session may be selected. Used by BOTH
// the network gateway (-> HTTP 400) and the in-terminal extension (-> notify/log),
// so the two entrypoints can't drift. Deselect (null/empty) is always valid.
export function validateOmpSelection(
	sessionPath: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): OmpSelectionValidation {
	const path = sessionPath?.trim();
	if (!path) return { ok: true }; // deselect
	const resolved = resolve(path);
	const inRoots = defaultOhMyPiSessionRoots(env).some((root) => {
		const resolvedRoot = resolve(root);
		return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep);
	});
	if (!inRoots) return { ok: false, error: "Session path is outside the configured oh-my-pi roots." };
	if (!existsSync(path)) return { ok: false, error: "Session file does not exist (it may have been archived or removed)." };
	return { ok: true };
}

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
	targetNode?: string;
};

export type LaunchTargetNode = "colab";

export type OhMyPiLaunchArgvResult =
	| { ok: true; argv: string[]; cwd: string; mode: "launch" | "hub"; targetNode?: string }
	| { ok: false; message: string };

export type ColabLaunchOptions = {
	cwd?: string;
	runId?: string;
	session?: string;
	target?: string;
	command?: string;
};

export type ColabLaunchPlanResult =
	| {
		ok: true;
		command: string;
		argv: string[];
		cwd: string;
		runId: string;
		session: string;
		target: string;
		commandPreview: string;
		shell: boolean;
	}
	| { ok: false; message: string };

const MAX_PROMPT_LENGTH = 4096;
const MAX_MODEL_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 128;
const MAX_TARGET_NODE_LENGTH = 64;
const MAX_RUN_ID_LENGTH = 128;
const MAX_COLAB_SESSION_LENGTH = 128;
const MAX_COLAB_TARGET_LENGTH = 256;
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

export function normalizeLaunchTargetNode(value: unknown): LaunchTargetNode | undefined | { error: string } {
	const targetNode = normalizeOptionalString(value, MAX_TARGET_NODE_LENGTH, "targetNode");
	if (targetNode === undefined) return undefined;
	if (typeof targetNode === "object") return targetNode;
	const normalized = targetNode.toLowerCase();
	if (normalized === "colab") return "colab";
	return { error: `Invalid targetNode: unsupported target "${targetNode}".` };
}

function resolveColabLaunchCommand(env: NodeJS.ProcessEnv = process.env) {
	const configured = env.PI_SPEAK_COLAB_LAUNCH_BIN?.trim()
		|| env.MESH_SYNC_BIN?.trim()
		|| "";
	if (configured) return configured;
	const appData = env.APPDATA?.trim();
	return appData ? `${appData}\\Antigravity\\bin\\mesh-sync.cmd` : "mesh-sync";
}

function quotePreviewArg(value: string) {
	if (!/[\s"]/u.test(value)) return value;
	return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildColabLaunchPlan(
	options: ColabLaunchOptions,
	fallbackCwd: string,
	env: NodeJS.ProcessEnv = process.env,
	now: () => number = Date.now,
): ColabLaunchPlanResult {
	const cwdNormalized = normalizeOptionalString(options.cwd, MAX_CWD_LENGTH, "cwd");
	if (cwdNormalized && typeof cwdNormalized === "object" && "error" in cwdNormalized) {
		return { ok: false, message: cwdNormalized.error };
	}
	const cwd = resolve(cwdNormalized ?? fallbackCwd);

	const runIdNormalized = normalizeOptionalString(options.runId, MAX_RUN_ID_LENGTH, "runId");
	if (runIdNormalized && typeof runIdNormalized === "object" && "error" in runIdNormalized) {
		return { ok: false, message: runIdNormalized.error };
	}
	const sessionNormalized = normalizeOptionalString(options.session, MAX_COLAB_SESSION_LENGTH, "session");
	if (sessionNormalized && typeof sessionNormalized === "object" && "error" in sessionNormalized) {
		return { ok: false, message: sessionNormalized.error };
	}
	const targetNormalized = normalizeOptionalString(options.target, MAX_COLAB_TARGET_LENGTH, "target");
	if (targetNormalized && typeof targetNormalized === "object" && "error" in targetNormalized) {
		return { ok: false, message: targetNormalized.error };
	}
	const commandNormalized = normalizeOptionalString(options.command, MAX_PATH_LENGTH, "command");
	if (commandNormalized && typeof commandNormalized === "object" && "error" in commandNormalized) {
		return { ok: false, message: commandNormalized.error };
	}

	const runId = runIdNormalized ?? `colab-${now()}`;
	const session = sessionNormalized ?? "mesh-colab";
	const target = targetNormalized ?? "/content/workspace";
	const command = commandNormalized ?? resolveColabLaunchCommand(env);
	const argv = ["colab-deploy", cwd, "--run-id", runId, "--session", session, "--target", target];
	const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
	return {
		ok: true,
		command,
		argv,
		cwd,
		runId,
		session,
		target,
		commandPreview: [command, ...argv].map(quotePreviewArg).join(" "),
		shell,
	};
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

	const targetNode = normalizeLaunchTargetNode(options.targetNode);
	if (targetNode && typeof targetNode === "object" && "error" in targetNode) {
		return { ok: false, message: targetNode.error };
	}

	if (options.hubOnly) {
		if (targetNode) return { ok: false, message: "Invalid launch: hubOnly cannot be combined with targetNode." };
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

	return { ok: true, argv, cwd, mode: "launch", targetNode };
}
