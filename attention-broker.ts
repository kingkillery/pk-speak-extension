import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AttentionSessionSnapshot = {
	sessionId: string;
	sessionName?: string;
	sessionPath?: string;
	pid: number;
	phase: string;
	waitingForAttention: boolean;
	readyAt?: number;
	lastAssistantText?: string;
	voiceTarget?: string;
	aliases: string[];
	updatedAt: number;
};

export type AttentionLeaderLease = {
	ownerSessionId: string;
	pid: number;
	updatedAt: number;
};

const SNAPSHOT_TTL_MS = Number.parseInt(process.env.PI_SPEAK_ATTENTION_TTL_MS || "90000", 10);
const LEASE_TTL_MS = Number.parseInt(process.env.PI_SPEAK_ATTENTION_LEASE_TTL_MS || "8000", 10);

function getBrokerRootDir() {
	const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.TEMP || process.cwd();
	return join(localAppData, "pi-speak-pk", "attention-broker");
}

function getSnapshotsDir() {
	return join(getBrokerRootDir(), "sessions");
}

function getLeasePath() {
	return join(getBrokerRootDir(), "leader.json");
}

function ensureBrokerDirs() {
	mkdirSync(getSnapshotsDir(), { recursive: true });
}

function getSnapshotPath(sessionId: string) {
	return join(getSnapshotsDir(), `${sessionId}.json`);
}

function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
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

export function buildAttentionSessionId(sessionPath?: string, pid = process.pid) {
	const raw = sessionPath || `unknown-session:${pid}`;
	return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

export function writeAttentionSnapshot(snapshot: AttentionSessionSnapshot) {
	ensureBrokerDirs();
	writeJsonFile(getSnapshotPath(snapshot.sessionId), snapshot);
}

export function removeAttentionSnapshot(sessionId: string) {
	try {
		rmSync(getSnapshotPath(sessionId), { force: true });
	} catch {}
}

export function readAttentionSnapshots(now = Date.now()) {
	ensureBrokerDirs();
	const snapshots: AttentionSessionSnapshot[] = [];
	for (const file of readdirSync(getSnapshotsDir())) {
		if (!file.endsWith(".json")) continue;
		const path = join(getSnapshotsDir(), file);
		const snapshot = readJsonFile<AttentionSessionSnapshot>(path);
		if (!snapshot) {
			rmSync(path, { force: true });
			continue;
		}
		if ((now - snapshot.updatedAt) > SNAPSHOT_TTL_MS) {
			rmSync(path, { force: true });
			continue;
		}
		snapshots.push(snapshot);
	}
	return snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readAttentionLeaderLease(now = Date.now()) {
	const lease = readJsonFile<AttentionLeaderLease>(getLeasePath());
	if (!lease) return undefined;
	if ((now - lease.updatedAt) > LEASE_TTL_MS) return undefined;
	return lease;
}

export function claimAttentionLeader(ownerSessionId: string, pid = process.pid, now = Date.now()) {
	ensureBrokerDirs();
	const current = readAttentionLeaderLease(now);
	if (current && current.ownerSessionId !== ownerSessionId) {
		return false;
	}
	writeJsonFile(getLeasePath(), {
		ownerSessionId,
		pid,
		updatedAt: now,
	} satisfies AttentionLeaderLease);
	return true;
}

/** Mark a real foreground/interaction event as the current attention owner. */
export function focusAttentionLeader(ownerSessionId: string, pid = process.pid, now = Date.now()) {
	ensureBrokerDirs();
	writeJsonFile(getLeasePath(), { ownerSessionId, pid, updatedAt: now } satisfies AttentionLeaderLease);
}

/** Refresh only an already-owned lease; heartbeats must never steal focus. */
export function renewAttentionLeader(ownerSessionId: string, pid = process.pid, now = Date.now()) {
	const current = readJsonFile<AttentionLeaderLease>(getLeasePath());
	if (!current || current.ownerSessionId !== ownerSessionId) return false;
	writeJsonFile(getLeasePath(), { ownerSessionId, pid, updatedAt: now } satisfies AttentionLeaderLease);
	return true;
}

export function releaseAttentionLeader(ownerSessionId: string) {
	const current = readJsonFile<AttentionLeaderLease>(getLeasePath());
	if (!current || current.ownerSessionId !== ownerSessionId) return;
	try {
		rmSync(getLeasePath(), { force: true });
	} catch {}
}

export function listReadyAttentionSessions(now = Date.now()) {
	return readAttentionSnapshots(now).filter((snapshot) => snapshot.waitingForAttention);
}

export function updateAttentionWaitingState(sessionId: string, waitingForAttention: boolean) {
	const path = getSnapshotPath(sessionId);
	const snapshot = readJsonFile<AttentionSessionSnapshot>(path);
	if (!snapshot) return false;
	writeAttentionSnapshot({
		...snapshot,
		waitingForAttention,
		readyAt: waitingForAttention ? (snapshot.readyAt || Date.now()) : undefined,
		updatedAt: Date.now(),
	});
	return true;
}
