import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	createSessionBundle,
	runGit,
	sanitizeBundleName,
	saveBundleToStore,
	type SessionBundle,
} from "./session-transfer.js";

/**
 * Per-session git worktrees for secondary hosts ("invoked via the Mac").
 *
 * When a session bundle is imported with `--worktree`, the workspace is not
 * reconciled into a fixed cwd. Instead:
 *   - one base clone per remote lives under `~/.pi-speak/repos/<repo-key>/`
 *   - `git fetch origin` runs in the base at hydrate time, so the branch tip
 *     is freshly pulled at the moment the session is invoked
 *   - the session gets its own worktree under `~/.pi-speak/worktrees/<name>/`,
 *     born clean, so the bundled uncommitted diff always applies
 *   - a lease file records ownership so an idle worktree can be reclaimed
 *
 * Cleanup is lease-based and never lossy: an expired dirty worktree is
 * rescued into a session bundle (transcript + git state) before removal, and
 * kept in place when the rescue fails.
 */

export const LEASE_FILE_SUFFIX = ".lease.json";
const DEFAULT_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type WorktreeLease = {
	kind: "pi-speak-worktree-lease";
	version: 1;
	/** Routing name of the owning session. */
	session: string;
	repoKey: string;
	remote: string;
	branch?: string;
	/** Bundle HEAD at hydrate time. */
	head?: string;
	/** Imported transcript path on this host; used to rescue dirty work into a bundle. */
	sessionPath?: string;
	createdAt: number;
	lastUsedAt: number;
};

export function getWorktreeRoot(home: string = homedir()): string {
	return join(home, ".pi-speak", "worktrees");
}

export function getRepoStoreRoot(home: string = homedir()): string {
	return join(home, ".pi-speak", "repos");
}

/** Idle TTL before a leased worktree is reclaimed by the sweep. */
export function getWorktreeTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const days = Number(env.PI_SPEAK_WORKTREE_TTL_DAYS);
	return (Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS) * DAY_MS;
}

/** Stable filesystem key for a git remote URL: `github.com-owner-repo`. */
export function repoKeyFromRemote(remote: string): string {
	const trimmed = remote.trim().replace(/\.git$/i, "");
	const withoutProtocol = trimmed.replace(/^[a-z+]+:\/\//i, "");
	const withoutUser = withoutProtocol.replace(/^[^/@]+@/, "");
	const key = withoutUser
		.replace(/:/g, "/")
		.split("/")
		.filter((part) => part.trim())
		.join("-")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return key.toLowerCase() || "repo";
}

// ---------------------------------------------------------------------------
// Lease I/O
// ---------------------------------------------------------------------------

/**
 * Leases live NEXT TO the worktree (`<worktree>.lease.json`), never inside it:
 * an in-tree lease would show up as an untracked file and make every worktree
 * read as dirty, defeating the clean/dirty sweep policy.
 */
export function worktreeLeasePath(worktreePath: string): string {
	return `${worktreePath.replace(/[\\/]+$/, "")}${LEASE_FILE_SUFFIX}`;
}

export function readWorktreeLease(worktreePath: string): WorktreeLease | undefined {
	try {
		const parsed = JSON.parse(readFileSync(worktreeLeasePath(worktreePath), "utf8"));
		if (parsed?.kind !== "pi-speak-worktree-lease" || typeof parsed?.session !== "string") return undefined;
		return parsed as WorktreeLease;
	} catch {
		return undefined;
	}
}

export function writeWorktreeLease(worktreePath: string, lease: WorktreeLease): void {
	writeFileSync(worktreeLeasePath(worktreePath), `${JSON.stringify(lease, null, 2)}\n`, "utf8");
}

/** Merge fields into an existing lease (e.g. the imported sessionPath, a lastUsedAt refresh). */
export function updateWorktreeLease(worktreePath: string, patch: Partial<WorktreeLease>): WorktreeLease | undefined {
	const lease = readWorktreeLease(worktreePath);
	if (!lease) return undefined;
	const next = { ...lease, ...patch };
	writeWorktreeLease(worktreePath, next);
	return next;
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

export type WorktreeHydrateResult = {
	ok: boolean;
	worktreePath?: string;
	steps: string[];
	warnings: string[];
};

/**
 * Ensure a freshly-pulled, per-session worktree for `bundle` and return its path.
 * Reuses an existing leased worktree for the same session (fast-forwarding it
 * when clean); otherwise fetches the base clone and adds a new worktree at the
 * bundle's branch tip, then applies the bundled uncommitted diff.
 */
export function hydrateSessionWorktree(
	bundle: SessionBundle,
	opts: { worktreeRoot?: string; repoRoot?: string; now?: number } = {},
): WorktreeHydrateResult {
	const steps: string[] = [];
	const warnings: string[] = [];
	const git = bundle.git;
	if (!git?.remote) {
		return { ok: false, steps, warnings: ["Bundle has no git remote; a worktree cannot be hydrated. Import with --cwd instead."] };
	}
	const now = opts.now ?? Date.now();
	const repoKey = repoKeyFromRemote(git.remote);
	const basePath = join(opts.repoRoot ?? getRepoStoreRoot(), repoKey);
	const worktreeName = sanitizeBundleName(bundle.name);
	const worktreePath = join(opts.worktreeRoot ?? getWorktreeRoot(), worktreeName);

	// Base clone: one BARE repo per remote, shared by every session worktree of
	// that repo. Bare means no branch is ever "already checked out" by the base
	// itself, so a worktree can be added for any branch — including the default.
	if (!existsSync(basePath)) {
		mkdirSync(resolve(basePath, ".."), { recursive: true });
		const clone = runGit(undefined, ["clone", "--bare", git.remote, basePath]);
		if (!clone.ok) return { ok: false, steps, warnings: [`git clone ${git.remote} failed: ${clone.stderr.trim()}`] };
		// Bare clones get no fetch refspec by default; without one, later fetches
		// would never update origin/* and the "pulled" guarantee silently dies.
		runGit(basePath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
		runGit(basePath, ["fetch", "origin", "--prune", "--quiet"]);
		steps.push(`cloned ${git.remote} -> ${basePath}`);
	} else {
		const gitDir = runGit(basePath, ["rev-parse", "--git-dir"]);
		if (!gitDir.ok) {
			return { ok: false, steps, warnings: [`${basePath} exists but is not a git repository. Remove it and retry.`] };
		}
	}

	// The "pulled" guarantee: fetch at invoke time, not sync time.
	const fetch = runGit(basePath, ["fetch", "origin", "--prune", "--quiet"]);
	if (fetch.ok) steps.push("fetched origin");
	else warnings.push(`git fetch failed (offline?): ${fetch.stderr.trim()}. Continuing with the last-known refs.`);

	// Reuse an existing worktree for this session.
	if (existsSync(worktreePath)) {
		const lease = readWorktreeLease(worktreePath);
		if (!lease) {
			return { ok: false, steps, warnings: [`${worktreePath} exists but carries no pi-speak lease; refusing to reuse it.`] };
		}
		const status = runGit(worktreePath, ["status", "--porcelain"]);
		if (status.ok && !status.stdout.trim() && lease.branch) {
			const ff = runGit(worktreePath, ["merge", "--ff-only", `origin/${lease.branch}`]);
			if (ff.ok) steps.push(`fast-forwarded ${lease.branch}`);
			else warnings.push(`Could not fast-forward ${lease.branch}; the worktree keeps its current state.`);
		} else if (status.ok && status.stdout.trim()) {
			warnings.push("Existing worktree is dirty; left as-is (bundled diff not re-applied).");
		}
		updateWorktreeLease(worktreePath, { lastUsedAt: now });
		steps.push(`reusing worktree ${worktreePath}`);
		return { ok: true, worktreePath, steps, warnings };
	}

	// Fresh worktree at the fetched branch tip (or detached at the bundle commit).
	mkdirSync(resolve(worktreePath, ".."), { recursive: true });
	let added = false;
	if (git.branch) {
		const remoteBranch = runGit(basePath, ["rev-parse", "--verify", "--quiet", `origin/${git.branch}`]);
		// Prefer the freshly fetched origin tip; -B also resets a stale local branch.
		let add = remoteBranch.ok
			? runGit(basePath, ["worktree", "add", "-B", git.branch, worktreePath, `origin/${git.branch}`])
			: runGit(basePath, ["worktree", "add", worktreePath, git.branch]);
		if (!add.ok && remoteBranch.ok) {
			// Branch is checked out in another session's worktree; detach at the same tip.
			add = runGit(basePath, ["worktree", "add", "--detach", worktreePath, `origin/${git.branch}`]);
			if (add.ok) warnings.push(`Branch ${git.branch} is checked out by another worktree; this one is detached at its tip.`);
		}
		if (add.ok) {
			added = true;
			steps.push(`added worktree at ${git.branch}`);
		} else {
			warnings.push(`Could not add worktree at branch ${git.branch}: ${add.stderr.trim()}`);
		}
	}
	if (!added && git.head) {
		const add = runGit(basePath, ["worktree", "add", "--detach", worktreePath, git.head]);
		if (add.ok) {
			added = true;
			steps.push(`added detached worktree at ${git.head.slice(0, 12)}`);
		} else {
			warnings.push(`Could not add detached worktree at ${git.head.slice(0, 12)}: ${add.stderr.trim()}`);
		}
	}
	if (!added) return { ok: false, steps, warnings: [...warnings, "Worktree could not be created from the bundle's branch or commit."] };

	if (git.head) {
		const head = runGit(worktreePath, ["rev-parse", "HEAD"]);
		if (head.ok && head.stdout.trim() !== git.head) {
			warnings.push(`Worktree HEAD is ${head.stdout.trim().slice(0, 12)} but the bundle was made at ${git.head.slice(0, 12)} (branch moved on).`);
		}
	}

	// Born clean, so the bundled uncommitted diff always has a clean tree to land on.
	if (git.patch) {
		const patchPath = join(tmpdir(), `pi-speak-worktree-${Date.now()}-${process.pid}.patch`);
		writeFileSync(patchPath, git.patch, "utf8");
		try {
			const apply = runGit(worktreePath, ["apply", "--3way", "--binary", patchPath]);
			if (apply.ok) steps.push("applied bundled uncommitted diff");
			else warnings.push(`git apply failed: ${apply.stderr.trim()}`);
		} finally {
			rmSync(patchPath, { force: true });
		}
	}

	writeWorktreeLease(worktreePath, {
		kind: "pi-speak-worktree-lease",
		version: 1,
		session: bundle.name,
		repoKey,
		remote: git.remote,
		...(git.branch ? { branch: git.branch } : {}),
		...(git.head ? { head: git.head } : {}),
		createdAt: now,
		lastUsedAt: now,
	});
	return { ok: true, worktreePath, steps, warnings };
}

// ---------------------------------------------------------------------------
// Sweep (automatic cleanup)
// ---------------------------------------------------------------------------

export type WorktreeStatus = {
	path: string;
	lease?: WorktreeLease;
	dirty: boolean;
};

export type WorktreeSweepAction = "keep" | "remove" | "rescue-then-remove" | "skip";

export type WorktreeSweepDecision = {
	path: string;
	session?: string;
	action: WorktreeSweepAction;
	reason: string;
};

export function listWorktreeStatuses(worktreeRoot: string = getWorktreeRoot()): WorktreeStatus[] {
	let entries: string[];
	try {
		entries = readdirSync(worktreeRoot);
	} catch {
		return [];
	}
	const statuses: WorktreeStatus[] = [];
	for (const entry of entries) {
		const path = join(worktreeRoot, entry);
		try {
			if (!statSync(path).isDirectory()) continue;
		} catch {
			continue;
		}
		const lease = readWorktreeLease(path);
		const status = runGit(path, ["status", "--porcelain"]);
		// Unreadable status counts as dirty: never treat unknown state as removable-clean.
		const dirty = !status.ok || !!status.stdout.trim();
		statuses.push({ path, ...(lease ? { lease } : {}), dirty });
	}
	return statuses;
}

/**
 * Pure sweep policy:
 *   - no lease -> skip (not ours to manage)
 *   - lease within TTL -> keep (unless forced by name)
 *   - expired + clean -> remove
 *   - expired + dirty -> rescue into a bundle, then remove
 */
export function planWorktreeSweep(
	statuses: readonly WorktreeStatus[],
	opts: { ttlMs?: number; now?: number; force?: string[] } = {},
): WorktreeSweepDecision[] {
	const ttlMs = opts.ttlMs ?? getWorktreeTtlMs();
	const now = opts.now ?? Date.now();
	const force = new Set((opts.force ?? []).map((name) => sanitizeBundleName(name)));
	return statuses.map((status) => {
		const lease = status.lease;
		if (!lease) {
			return { path: status.path, action: "skip" as const, reason: "no pi-speak lease; not managed" };
		}
		const forced = force.has(sanitizeBundleName(lease.session)) || force.has(basename(status.path));
		const idleMs = now - lease.lastUsedAt;
		if (!forced && idleMs < ttlMs) {
			const idleDays = Math.floor(idleMs / DAY_MS);
			return { path: status.path, session: lease.session, action: "keep" as const, reason: `idle ${idleDays}d, within TTL` };
		}
		const why = forced ? "removal requested" : `idle past TTL (${Math.floor(idleMs / DAY_MS)}d)`;
		if (status.dirty) {
			return { path: status.path, session: lease.session, action: "rescue-then-remove" as const, reason: `${why}, dirty tree` };
		}
		return { path: status.path, session: lease.session, action: "remove" as const, reason: `${why}, clean tree` };
	});
}

export type WorktreeSweepResult = {
	decisions: WorktreeSweepDecision[];
	steps: string[];
	warnings: string[];
};

/**
 * Execute the sweep policy. Dirty worktrees are rescued into a session bundle
 * (`<name>-rescued`) carrying the transcript recorded in the lease plus the
 * live git state; a failed rescue keeps the worktree in place.
 */
export function sweepWorktrees(
	opts: {
		worktreeRoot?: string;
		repoRoot?: string;
		bundleDir?: string;
		ttlMs?: number;
		now?: number;
		force?: string[];
	} = {},
): WorktreeSweepResult {
	const worktreeRoot = opts.worktreeRoot ?? getWorktreeRoot();
	const repoRoot = opts.repoRoot ?? getRepoStoreRoot();
	const statuses = listWorktreeStatuses(worktreeRoot);
	const decisions = planWorktreeSweep(statuses, { ttlMs: opts.ttlMs, now: opts.now, force: opts.force });
	const steps: string[] = [];
	const warnings: string[] = [];

	const prunedBases = new Set<string>();
	for (const decision of decisions) {
		if (decision.action === "keep" || decision.action === "skip") continue;
		const lease = readWorktreeLease(decision.path);
		if (!lease) {
			warnings.push(`${decision.path}: lease disappeared mid-sweep; skipped.`);
			continue;
		}
		if (decision.action === "rescue-then-remove") {
			const rescued = rescueWorktree(decision.path, lease, opts.bundleDir);
			if (!rescued.ok) {
				warnings.push(`${decision.path}: ${rescued.reason} Worktree kept in place.`);
				continue;
			}
			steps.push(`rescued dirty work of "${lease.session}" -> ${rescued.bundlePath}`);
		}
		const basePath = join(repoRoot, lease.repoKey);
		const removed = runGit(basePath, ["worktree", "remove", "--force", decision.path]);
		if (!removed.ok) {
			// Base clone may be gone; fall back to plain directory removal.
			try {
				rmSync(decision.path, { recursive: true, force: true });
			} catch (error) {
				warnings.push(`${decision.path}: could not remove worktree: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
		}
		rmSync(worktreeLeasePath(decision.path), { force: true });
		steps.push(`removed worktree ${decision.path} (${decision.reason})`);
		if (existsSync(basePath) && !prunedBases.has(basePath)) {
			runGit(basePath, ["worktree", "prune"]);
			prunedBases.add(basePath);
		}
	}
	return { decisions, steps, warnings };
}

function rescueWorktree(
	worktreePath: string,
	lease: WorktreeLease,
	bundleDir?: string,
): { ok: true; bundlePath: string } | { ok: false; reason: string } {
	if (!lease.sessionPath || !existsSync(lease.sessionPath)) {
		return { ok: false, reason: "dirty tree but the leased transcript is missing; cannot rescue safely." };
	}
	try {
		const { bundle } = createSessionBundle({
			name: `${lease.session}-rescued`,
			aliases: [],
			sessionPath: lease.sessionPath,
			cwd: worktreePath,
			note: `Auto-rescued from idle worktree ${worktreePath} before cleanup.`,
		});
		const bundlePath = saveBundleToStore(bundle, bundleDir);
		return { ok: true, bundlePath };
	} catch (error) {
		return { ok: false, reason: `rescue bundling failed: ${error instanceof Error ? error.message : String(error)}.` };
	}
}

/** One-line-per-worktree summary for `/sess wt list`. */
export function formatWorktreeList(statuses: readonly WorktreeStatus[], now: number = Date.now()): string[] {
	if (statuses.length === 0) return ["No session worktrees."];
	return statuses.map((status) => {
		const lease = status.lease;
		if (!lease) return `${status.path} — unmanaged (no lease)`;
		const idleDays = Math.max(0, Math.floor((now - lease.lastUsedAt) / DAY_MS));
		const branch = lease.branch ? ` @ ${lease.branch}` : "";
		return `${lease.session}${branch} — ${status.dirty ? "dirty" : "clean"}, idle ${idleDays}d — ${status.path}`;
	});
}

