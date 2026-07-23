import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	LEASE_FILE_SUFFIX,
	formatWorktreeList,
	getWorktreeTtlMs,
	hydrateSessionWorktree,
	listWorktreeStatuses,
	planWorktreeSweep,
	readWorktreeLease,
	repoKeyFromRemote,
	sweepWorktrees,
	updateWorktreeLease,
	worktreeLeasePath,
} from "../dist/session-worktree.js";
import { buildSessionManifest, captureGitState, captureGitSummary } from "../dist/session-transfer.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** Bare origin + a pushed work clone on `main`, ready for branch/patch scenarios. */
function makeRemoteWithWork(prefix) {
	const root = tempDir(prefix);
	const origin = join(root, "origin.git");
	mkdirSync(origin);
	git(origin, "init", "--bare", "--initial-branch=main");
	const work = join(root, "work");
	git(root, "clone", origin, work);
	git(work, "config", "user.email", "test@example.com");
	git(work, "config", "user.name", "Test");
	writeFileSync(join(work, "file.txt"), "one\n");
	git(work, "add", ".");
	git(work, "commit", "-m", "init");
	git(work, "push", "origin", "main");
	return { root, origin, work };
}

function makeBundle(name, gitState, overrides = {}) {
	return {
		kind: "pi-speak-session-bundle",
		version: 1,
		createdAt: Date.now(),
		name,
		aliases: [],
		provider: "pi",
		host: { hostname: "test-host", platform: "test" },
		cwd: "C:/src/unused",
		sessionFileName: `${name}.jsonl`,
		transcript: JSON.stringify({ type: "session", cwd: "C:/src/unused" }),
		...(gitState ? { git: gitState } : {}),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// repoKeyFromRemote
// ---------------------------------------------------------------------------

test("repoKeyFromRemote normalizes https, scp-like, and ssh remotes to one key", () => {
	assert.equal(repoKeyFromRemote("https://github.com/Owner/Repo.git"), "github.com-owner-repo");
	assert.equal(repoKeyFromRemote("git@github.com:Owner/Repo.git"), "github.com-owner-repo");
	assert.equal(repoKeyFromRemote("ssh://git@github.com/Owner/Repo"), "github.com-owner-repo");
});

test("repoKeyFromRemote survives local paths and hostile characters", () => {
	const key = repoKeyFromRemote("C:/temp/some repo/origin.git");
	assert.match(key, /^[a-z0-9._-]+$/);
	assert.equal(repoKeyFromRemote("   "), "repo");
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

test("hydrateSessionWorktree creates a fresh worktree at the branch tip and applies the dirty patch", () => {
	const { root, work } = makeRemoteWithWork("pi-wt-hydrate-");
	git(work, "checkout", "-b", "feature");
	writeFileSync(join(work, "file.txt"), "one\ntwo\n");
	git(work, "add", ".");
	git(work, "commit", "-m", "feature work");
	git(work, "push", "origin", "feature");
	// Uncommitted edit travels as the bundle patch.
	writeFileSync(join(work, "file.txt"), "one\ntwo\nthree-dirty\n");
	const captured = captureGitState(work);
	assert.ok(captured.git?.patch, "expected a dirty patch in the captured state");

	const worktreeRoot = join(root, "worktrees");
	const repoRoot = join(root, "repos");
	const bundle = makeBundle("voice-work", captured.git);
	const result = hydrateSessionWorktree(bundle, { worktreeRoot, repoRoot });

	assert.equal(result.ok, true, result.warnings.join("; "));
	assert.ok(result.worktreePath && existsSync(result.worktreePath));
	assert.equal(git(result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
	// Normalize: Windows checkouts may materialize CRLF via core.autocrlf.
	assert.equal(readFileSync(join(result.worktreePath, "file.txt"), "utf8").replace(/\r\n/g, "\n"), "one\ntwo\nthree-dirty\n");
	const lease = readWorktreeLease(result.worktreePath);
	assert.equal(lease?.session, "voice-work");
	assert.equal(lease?.branch, "feature");
	// The lease must not pollute the tree: only the patch shows in git status.
	const status = git(result.worktreePath, "status", "--porcelain");
	assert.ok(!status.includes(LEASE_FILE_SUFFIX), `lease leaked into the worktree: ${status}`);
});

test("hydrateSessionWorktree reuses an existing clean worktree and fast-forwards it", () => {
	const { root, work } = makeRemoteWithWork("pi-wt-reuse-");
	const captured = captureGitState(work);
	const worktreeRoot = join(root, "worktrees");
	const repoRoot = join(root, "repos");
	const bundle = makeBundle("reuse-me", { remote: captured.git.remote, branch: "main", head: captured.git.head });

	const first = hydrateSessionWorktree(bundle, { worktreeRoot, repoRoot });
	assert.equal(first.ok, true, first.warnings.join("; "));

	// Branch moves on upstream; a re-invoke must land on the new tip.
	writeFileSync(join(work, "file.txt"), "one\nmore\n");
	git(work, "add", ".");
	git(work, "commit", "-m", "advance");
	git(work, "push", "origin", "main");
	const newTip = git(work, "rev-parse", "HEAD");

	const second = hydrateSessionWorktree(bundle, { worktreeRoot, repoRoot });
	assert.equal(second.ok, true, second.warnings.join("; "));
	assert.equal(second.worktreePath, first.worktreePath);
	assert.ok(second.steps.some((step) => step.startsWith("fast-forwarded")), second.steps.join("; "));
	assert.equal(git(second.worktreePath, "rev-parse", "HEAD"), newTip);
});

test("hydrateSessionWorktree refuses bundles without a git remote", () => {
	const result = hydrateSessionWorktree(makeBundle("no-remote", undefined));
	assert.equal(result.ok, false);
	assert.match(result.warnings.join(" "), /no git remote/i);
});

// ---------------------------------------------------------------------------
// Sweep policy (pure)
// ---------------------------------------------------------------------------

test("planWorktreeSweep: skip unmanaged, keep fresh, remove expired-clean, rescue expired-dirty", () => {
	const now = 100 * DAY_MS;
	const lease = (session, idleDays) => ({
		kind: "pi-speak-worktree-lease",
		version: 1,
		session,
		repoKey: "k",
		remote: "r",
		createdAt: 0,
		lastUsedAt: now - idleDays * DAY_MS,
	});
	const decisions = planWorktreeSweep(
		[
			{ path: "/wt/unmanaged", dirty: false },
			{ path: "/wt/fresh", lease: lease("fresh", 1), dirty: true },
			{ path: "/wt/old-clean", lease: lease("old-clean", 10), dirty: false },
			{ path: "/wt/old-dirty", lease: lease("old-dirty", 10), dirty: true },
		],
		{ ttlMs: 7 * DAY_MS, now },
	);
	assert.deepEqual(decisions.map((d) => d.action), ["skip", "keep", "remove", "rescue-then-remove"]);
});

test("planWorktreeSweep force removes a named session regardless of TTL", () => {
	const now = Date.now();
	const decisions = planWorktreeSweep(
		[{
			path: "/wt/fresh",
			lease: { kind: "pi-speak-worktree-lease", version: 1, session: "fresh", repoKey: "k", remote: "r", createdAt: now, lastUsedAt: now },
			dirty: false,
		}],
		{ ttlMs: 7 * DAY_MS, now, force: ["fresh"] },
	);
	assert.equal(decisions[0].action, "remove");
	assert.match(decisions[0].reason, /requested/);
});

test("getWorktreeTtlMs honors PI_SPEAK_WORKTREE_TTL_DAYS and falls back to 7 days", () => {
	assert.equal(getWorktreeTtlMs({ PI_SPEAK_WORKTREE_TTL_DAYS: "2" }), 2 * DAY_MS);
	assert.equal(getWorktreeTtlMs({}), 7 * DAY_MS);
	assert.equal(getWorktreeTtlMs({ PI_SPEAK_WORKTREE_TTL_DAYS: "junk" }), 7 * DAY_MS);
});

// ---------------------------------------------------------------------------
// Sweep execution
// ---------------------------------------------------------------------------

test("sweepWorktrees removes an expired clean worktree and its lease", () => {
	const { root, work } = makeRemoteWithWork("pi-wt-gc-clean-");
	const captured = captureGitState(work);
	const worktreeRoot = join(root, "worktrees");
	const repoRoot = join(root, "repos");
	const bundle = makeBundle("stale", { remote: captured.git.remote, branch: "main" });
	const hydrated = hydrateSessionWorktree(bundle, { worktreeRoot, repoRoot });
	assert.equal(hydrated.ok, true);
	updateWorktreeLease(hydrated.worktreePath, { lastUsedAt: Date.now() - 30 * DAY_MS });

	const swept = sweepWorktrees({ worktreeRoot, repoRoot, ttlMs: 7 * DAY_MS });
	assert.equal(swept.warnings.length, 0, swept.warnings.join("; "));
	assert.ok(!existsSync(hydrated.worktreePath), "worktree should be gone");
	assert.ok(!existsSync(worktreeLeasePath(hydrated.worktreePath)), "lease should be gone");
});

test("sweepWorktrees rescues dirty work into a bundle before removal", () => {
	const { root, work } = makeRemoteWithWork("pi-wt-gc-rescue-");
	const captured = captureGitState(work);
	const worktreeRoot = join(root, "worktrees");
	const repoRoot = join(root, "repos");
	const bundleDir = join(root, "bundles");
	const bundle = makeBundle("dirty-session", { remote: captured.git.remote, branch: "main" });
	const hydrated = hydrateSessionWorktree(bundle, { worktreeRoot, repoRoot });
	assert.equal(hydrated.ok, true);

	// Dirty the tree and give the lease a transcript to rescue.
	writeFileSync(join(hydrated.worktreePath, "file.txt"), "unsaved work\n");
	const transcriptPath = join(root, "dirty-session.jsonl");
	writeFileSync(transcriptPath, JSON.stringify({ type: "session", cwd: hydrated.worktreePath }));
	updateWorktreeLease(hydrated.worktreePath, { sessionPath: transcriptPath, lastUsedAt: Date.now() - 30 * DAY_MS });

	const swept = sweepWorktrees({ worktreeRoot, repoRoot, bundleDir, ttlMs: 7 * DAY_MS });
	assert.ok(!existsSync(hydrated.worktreePath), "worktree should be removed after rescue");
	const rescued = readdirSync(bundleDir).filter((name) => name.includes("rescued"));
	assert.equal(rescued.length, 1, `expected one rescue bundle, saw: ${rescued.join(", ")}`);
	const saved = JSON.parse(readFileSync(join(bundleDir, rescued[0]), "utf8"));
	assert.match(saved.git.patch, /unsaved work/);
	assert.ok(swept.steps.some((step) => step.includes("rescued")), swept.steps.join("; "));
});

test("sweepWorktrees keeps a dirty worktree when the rescue transcript is missing", () => {
	const { root, work } = makeRemoteWithWork("pi-wt-gc-keep-");
	const captured = captureGitState(work);
	const worktreeRoot = join(root, "worktrees");
	const repoRoot = join(root, "repos");
	const bundle = makeBundle("unrescuable", { remote: captured.git.remote, branch: "main" });
	const hydrated = hydrateSessionWorktree(bundle, { worktreeRoot, repoRoot });
	assert.equal(hydrated.ok, true);
	writeFileSync(join(hydrated.worktreePath, "file.txt"), "unsaved work\n");
	updateWorktreeLease(hydrated.worktreePath, { lastUsedAt: Date.now() - 30 * DAY_MS });

	const swept = sweepWorktrees({ worktreeRoot, repoRoot, ttlMs: 7 * DAY_MS });
	assert.ok(existsSync(hydrated.worktreePath), "dirty worktree must survive a failed rescue");
	assert.ok(swept.warnings.some((warning) => warning.includes("cannot rescue")), swept.warnings.join("; "));
});

test("listWorktreeStatuses and formatWorktreeList report lease state and cleanliness", () => {
	const { root, work } = makeRemoteWithWork("pi-wt-list-");
	const captured = captureGitState(work);
	const worktreeRoot = join(root, "worktrees");
	const repoRoot = join(root, "repos");
	const hydrated = hydrateSessionWorktree(makeBundle("listed", { remote: captured.git.remote, branch: "main" }), { worktreeRoot, repoRoot });
	assert.equal(hydrated.ok, true);

	const statuses = listWorktreeStatuses(worktreeRoot);
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0].lease?.session, "listed");
	assert.equal(statuses[0].dirty, false);
	assert.match(formatWorktreeList(statuses).join("\n"), /listed @ main — clean/);
	assert.deepEqual(formatWorktreeList([]), ["No session worktrees."]);
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test("captureGitSummary reports identity without a patch and flags dirty trees", () => {
	const { work } = makeRemoteWithWork("pi-wt-summary-");
	const clean = captureGitSummary(work);
	assert.equal(clean.branch, "main");
	assert.ok(clean.remote);
	assert.ok(clean.head);
	assert.equal(clean.dirty, false);
	assert.equal(clean.patch, undefined);
	writeFileSync(join(work, "file.txt"), "changed\n");
	assert.equal(captureGitSummary(work).dirty, true);
	assert.equal(captureGitSummary(tempDir("pi-wt-nongit-")), undefined);
});

test("buildSessionManifest summarizes git once per unique cwd and skips missing ones", () => {
	const { work } = makeRemoteWithWork("pi-wt-manifest-");
	let calls = 0;
	const manifest = buildSessionManifest(
		[
			{ name: "a", workingDirectory: work, aliases: ["one"], lastActivity: 123 },
			{ name: "b", cwd: work },
			{ name: "c", cwd: join(work, "does-not-exist") },
			{ name: "d" },
		],
		(cwd) => {
			calls += 1;
			return { remote: `remote-of-${cwd}`, branch: "main" };
		},
	);
	assert.equal(calls, 1, "summarize must be cached per cwd");
	assert.equal(manifest[0].git.branch, "main");
	assert.deepEqual(manifest[0].aliases, ["one"]);
	assert.equal(manifest[0].lastActivity, 123);
	assert.equal(manifest[1].git.remote, manifest[0].git.remote);
	assert.equal(manifest[2].git, undefined);
	assert.equal(manifest[3].cwd, undefined);
	assert.deepEqual(manifest[3].aliases, []);
});
