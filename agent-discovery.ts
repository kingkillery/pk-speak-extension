import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export type RunningAgentProcess = {
	provider: string;
	pid: number;
	target: string;
	cwd?: string;
	cwdBasename?: string;
	commandLine?: string;
	startedAt?: string;
	source: "process";
};

export type RecentAgentSession = {
	provider: string;
	path: string;
	sessionId?: string;
	title?: string;
	updatedAt?: string | null;
	cwd?: string;
	cwdBasename?: string;
	sourceHint?: string;
};

export type AgentDiscoverySnapshot = {
	generatedAt: string;
	targets: string[];
	running: RunningAgentProcess[];
	recent: RecentAgentSession[];
};

export function resolveWindowsNpmShim(name: string): string | undefined {
	if (process.platform !== "win32") return undefined;
	const appData = process.env.APPDATA;
	if (!appData) return undefined;
	const candidates = [name, `${name}.cmd`, `${name}.ps1`];
	for (const candidate of candidates) {
		const full = join(appData, "npm", candidate);
		if (existsSync(full)) return full;
	}
	return undefined;
}

export function resolveWindowsPiNodeCommand(piBin: string): { file: string; args: string[]; shell?: boolean } | undefined {
	if (process.platform !== "win32") return undefined;
	const normalized = piBin.toLowerCase().replace(/\\/g, "/");
	if (!normalized.endsWith("/pi.cmd") && !normalized.endsWith("/pi.ps1") && !normalized.endsWith("/pi")) return undefined;
	const binDir = dirname(piBin);
	const cli = join(binDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");
	if (!existsSync(cli)) return undefined;
	return { file: process.execPath, args: [cli], shell: false };
}

let cachedAgents: { at: number; targets: string[] } | undefined;
let cachedInventory: { at: number; snapshot: AgentDiscoverySnapshot } | undefined;
const DEFAULT_AGENT_DISCOVERY_TTL_MS = 2000;

export function discoverOpenAgentTargets(): string[] {
	return discoverRunningAgentProcesses().map((agent) => agent.target);
}

export function discoverOpenAgentTargetsCached(ttlMs = DEFAULT_AGENT_DISCOVERY_TTL_MS): string[] {
	const now = Date.now();
	if (cachedAgents && now - cachedAgents.at < ttlMs) return cachedAgents.targets;
	const targets = discoverOpenAgentTargets();
	cachedAgents = { at: now, targets };
	return targets;
}

export function discoverAgentInventory(options: { recentLimit?: number } = {}): AgentDiscoverySnapshot {
	const running = discoverRunningAgentProcesses();
	const recentLimit = options.recentLimit ?? 20;
	return {
		generatedAt: new Date().toISOString(),
		targets: running.map((agent) => agent.target),
		running,
		recent: mergeRecentSessions([
			...discoverCodexRecentSessions(recentLimit),
			...discoverClaudeRecentSessions(recentLimit),
		]).slice(0, recentLimit),
	};
}

let inventoryRefreshInFlight = false;

function refreshInventorySnapshot(): AgentDiscoverySnapshot {
	const snapshot = discoverAgentInventory();
	cachedInventory = { at: Date.now(), snapshot };
	return snapshot;
}

function scheduleInventoryRefresh(): void {
	if (inventoryRefreshInFlight) return;
	inventoryRefreshInFlight = true;
	// Defer the heavy discovery (PowerShell process scan + jsonl reads) off the
	// request path so the dashboard returns the last snapshot instantly and only
	// pays the scan cost asynchronously (serve-stale-while-revalidate).
	setImmediate(() => {
		try {
			refreshInventorySnapshot();
		} catch {
			// Keep the previous snapshot on refresh failure.
		} finally {
			inventoryRefreshInFlight = false;
		}
	});
}

export function discoverAgentInventoryCached(ttlMs = DEFAULT_AGENT_DISCOVERY_TTL_MS): AgentDiscoverySnapshot {
	const now = Date.now();
	// ttlMs === 0 forces a fresh, blocking scan (callers that need
	// up-to-the-moment data, e.g. resume resolution).
	if (ttlMs <= 0) return refreshInventorySnapshot();
	if (cachedInventory) {
		if (now - cachedInventory.at >= ttlMs) scheduleInventoryRefresh();
		return cachedInventory.snapshot;
	}
	// No snapshot yet: the very first call must block to return real data.
	return refreshInventorySnapshot();
}

function discoverRunningAgentProcesses(): RunningAgentProcess[] {
	if (process.platform !== "win32") return [];
	try {
		const script = [
			"$selfPid = " + process.pid,
			"Get-CimInstance Win32_Process |",
			"Where-Object {",
			"  if ($_.ProcessId -eq $selfPid) { return $false }",
			"  $name = [IO.Path]::GetFileNameWithoutExtension($_.Name).ToLowerInvariant()",
			"  $cmd = [string]$_.CommandLine",
			"  if ($name -match '^(codex|pi|claude|gemini|agy|antigravity)$') { return $true }",
			"  return $cmd -match '(^|[\\\\/\\s\\\"''])(codex|pi|claude|gemini|agy|antigravity)(\\.cmd|\\.ps1|\\.exe|\\.js)([\\s\\\"'']|$)'",
			"} |",
			"ForEach-Object {",
			"  $processName = [IO.Path]::GetFileNameWithoutExtension($_.Name).ToLowerInvariant()",
			"  $cmd = [string]$_.CommandLine",
			"  $provider = $processName",
			"  if ($provider -notmatch '^(codex|pi|claude|gemini|agy|antigravity)$') {",
			"    if ($cmd -match '(^|[\\\\/\\s\\\"''])(codex|pi|claude|gemini|agy|antigravity)(\\.cmd|\\.ps1|\\.exe|\\.js)([\\s\\\"'']|$)') { $provider = $Matches[2].ToLowerInvariant() }",
			"    else { $provider = 'agent' }",
			"  }",
			"  $cwd = ''",
			"  if ($_.CommandLine -match '-C\\s+\"([^\"]+)\"') { $cwd = $Matches[1] }",
			"  elseif ($_.CommandLine -match '--cwd\\s+\"([^\"]+)\"') { $cwd = $Matches[1] }",
			"  elseif ($_.CommandLine -match '-C\\s+([^\\s]+)') { $cwd = $Matches[1] }",
			"  elseif ($_.CommandLine -match '--cwd\\s+([^\\s]+)') { $cwd = $Matches[1] }",
			"  $cwdBase = ''",
			"  if ($cwd) { try { $cwdBase = Split-Path -Leaf $cwd } catch {} }",
			"  $startedAt = ''",
			"  if ($_.CreationDate) { try { $startedAt = $_.CreationDate.ToUniversalTime().ToString('o') } catch {} }",
			"  [PSCustomObject]@{ provider = $provider; pid = $_.ProcessId; cwd = $cwd; cwdBasename = $cwdBase; commandLine = $cmd; startedAt = $startedAt }",
			"} | ConvertTo-Json -Compress",
		].join("\n");
		const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 5000,
		}).trim();
		if (!output) return [];
		const parsed = JSON.parse(output);
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		const agents: RunningAgentProcess[] = rows
			.map((row) => {
				const provider = typeof row.provider === "string" ? row.provider.trim().toLowerCase() : "agent";
				const pid = typeof row.pid === "number" ? row.pid : Number.parseInt(String(row.pid || ""), 10);
				const cwd = typeof row.cwd === "string" ? row.cwd.trim() : "";
				const cwdBasename = typeof row.cwdBasename === "string" && row.cwdBasename.trim()
					? row.cwdBasename.trim()
					: cwd
						? cwd.replace(/^.*[\\/]/, "")
						: undefined;
				const target = Number.isFinite(pid)
					? `${provider}:${pid}${cwdBasename ? ` ${cwdBasename}` : ""}`
					: "";
				if (!target) return undefined;
				const agent: RunningAgentProcess = {
					provider,
					pid,
					target,
					cwd: cwd || undefined,
					cwdBasename,
					commandLine: typeof row.commandLine === "string" ? row.commandLine : undefined,
					startedAt: typeof row.startedAt === "string" ? row.startedAt : undefined,
					source: "process" as const,
				};
				return agent;
			})
			.filter((agent): agent is RunningAgentProcess => !!agent);
		return agents.sort((left, right) => left.target.localeCompare(right.target));
	} catch {
		return [];
	}
}

function discoverCodexRecentSessions(limit: number): RecentAgentSession[] {
	const root = join(homedir(), ".codex", "sessions");
	if (!existsSync(root)) return [];
	const files: { path: string; mtimeMs: number; updatedAt: string }[] = [];
	collectJsonlFiles(root, files);
	return files
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(0, Math.max(0, limit))
		.map((file) => {
			const meta = readCodexSessionMeta(file.path);
			const cwd = stringValue(meta?.cwd);
			const cwdBasename = cwd ? cwd.replace(/^.*[\\/]/, "") : undefined;
			const sessionId = stringValue(meta?.id) || file.path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/i, "");
			return {
				provider: "codex",
				path: file.path,
				sessionId,
				title: cwdBasename ? `Codex: ${cwdBasename}` : "Codex session",
				updatedAt: file.updatedAt,
				cwd: cwd || undefined,
				cwdBasename,
				sourceHint: "codex-session",
			};
		});
}

function discoverClaudeRecentSessions(limit: number): RecentAgentSession[] {
	const root = join(homedir(), ".claude", "projects");
	if (!existsSync(root)) return [];
	const files: { path: string; mtimeMs: number; updatedAt: string }[] = [];
	collectJsonlFiles(root, files);
	return files
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(0, Math.max(0, limit))
		.map((file) => {
			const meta = readClaudeSessionMeta(file.path);
			const cwd = stringValue(meta.cwd);
			const cwdBasename = cwd ? cwd.replace(/^.*[\\/]/, "") : undefined;
			const sessionId = meta.sessionId || file.path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/i, "");
			return {
				provider: "claude",
				path: file.path,
				sessionId,
				title: cwdBasename ? `Claude: ${cwdBasename}` : "Claude session",
				updatedAt: file.updatedAt,
				cwd: cwd || undefined,
				cwdBasename,
				sourceHint: "claude-session",
			};
		});
}

function readClaudeSessionMeta(path: string): { cwd: string; sessionId: string } {
	// Claude jsonl records carry `cwd`/`sessionId` on the first handful of lines,
	// not necessarily line 1. Read a small prefix and scan up to 16 lines so the
	// per-file cost stays in the sub-millisecond range (vs. the 2.8s `sm` spawn).
	let cwd = "";
	let sessionId = "";
	const prefix = readFilePrefix(path, 32 * 1024);
	if (!prefix) return { cwd, sessionId };
	const lines = prefix.split("\n");
	for (let i = 0; i < lines.length && i < 16; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object") {
				if (!cwd) cwd = stringValue((parsed as Record<string, unknown>).cwd);
				if (!sessionId) sessionId = stringValue((parsed as Record<string, unknown>).sessionId);
				if (cwd && sessionId) break;
			}
		} catch {
			// Skip partial trailing line or malformed record.
		}
	}
	return { cwd, sessionId };
}

function collectJsonlFiles(dir: string, files: { path: string; mtimeMs: number; updatedAt: string }[]): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectJsonlFiles(path, files);
			continue;
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) continue;
		try {
			const stat = statSync(path);
			files.push({ path, mtimeMs: stat.mtimeMs, updatedAt: stat.mtime.toISOString() });
		} catch {
			// Skip files that moved or cannot be read while the session store is active.
		}
	}
}

function readCodexSessionMeta(path: string): Record<string, unknown> | undefined {
	const line = readFileFirstLine(path, 128 * 1024);
	if (!line) return undefined;
	try {
		const parsed = JSON.parse(line);
		if (parsed && typeof parsed === "object" && parsed.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
			return parsed.payload as Record<string, unknown>;
		}
	} catch {
		// Ignore malformed or partial session headers.
	}
	return undefined;
}

function readFilePrefix(path: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(maxBytes);
		const bytes = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytes).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
	}
}

function readFileFirstLine(path: string, maxBytes: number): string {
	const prefix = readFilePrefix(path, maxBytes);
	if (!prefix) return "";
	const newline = prefix.indexOf("\n");
	return (newline >= 0 ? prefix.slice(0, newline) : prefix).trim();
}

function mergeRecentSessions(sessions: RecentAgentSession[]): RecentAgentSession[] {
	const seen = new Set<string>();
	const merged: RecentAgentSession[] = [];
	for (const session of sessions) {
		const key = session.path.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(session);
	}
	return merged.sort((left, right) => {
		const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
		const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
		return rightTime - leftTime;
	});
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
