import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PersistedSessionRouting = {
	version: 1;
	updatedAt: number;
	sessions: Record<string, string>;
	aliases: Record<string, string>;
};

function getStoreRootDir() {
	const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.TEMP || process.cwd();
	return join(localAppData, "pi-speak-pk");
}

export function getSessionRoutingStorePath() {
	return join(getStoreRootDir(), "session-routing.json");
}

function ensureStoreDir() {
	mkdirSync(getStoreRootDir(), { recursive: true });
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJsonFile(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
	if (existsSync(path)) rmSync(path, { force: true });
	try {
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

function sanitizeRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	const clean: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") clean[key] = entry;
	}
	return clean;
}

export function loadPersistedSessionRouting(): PersistedSessionRouting {
	const stored = readJsonFile(getSessionRoutingStorePath()) as Partial<PersistedSessionRouting> | undefined;
	return {
		version: 1,
		updatedAt: typeof stored?.updatedAt === "number" ? stored.updatedAt : 0,
		sessions: sanitizeRecord(stored?.sessions),
		aliases: sanitizeRecord(stored?.aliases),
	};
}

export function persistSessionRouting(state: { sessions: Record<string, string>; aliases: Record<string, string> }) {
	ensureStoreDir();
	writeJsonFile(getSessionRoutingStorePath(), {
		version: 1,
		updatedAt: Date.now(),
		sessions: { ...state.sessions },
		aliases: { ...state.aliases },
	});
}
