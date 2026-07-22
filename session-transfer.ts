import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Portable session bundles: capture a Pi session transcript plus its routing
 * metadata and workspace git state so the session can be re-opened on another
 * host ("pickup from anywhere"). Transfer is file-based — the bundle is a
 * single JSON document that travels over scp, a synced folder, or a git repo.
 *
 * The one dependency a bundle cannot carry is the live environment itself
 * (open browsers, running emulators, credentials). Those expectations are
 * recorded as a free-form `note` and surfaced verbatim on import.
 */

export type SessionBundleGit = {
	remote?: string;
	branch?: string;
	head?: string;
	/** `git diff HEAD --binary` output for uncommitted work. Capped; omitted with a warning when oversized. */
	patch?: string;
	/** Untracked, non-ignored paths (names only — contents are never embedded, to avoid leaking secrets). */
	untracked?: string[];
};

export type SessionBundle = {
	kind: "pi-speak-session-bundle";
	version: 1;
	createdAt: number;
	/** Routing name the session was saved under. */
	name: string;
	/** Wake aliases that pointed at this session on the source host. */
	aliases: string[];
	host: { hostname: string; platform: string };
	/** Workspace cwd on the source host. */
	cwd: string;
	/** Operator note: environment expectations (e.g. "Chrome open with dev profile"). */
	note?: string;
	git?: SessionBundleGit;
	sessionFileName: string;
	/** Full session JSONL text. */
	transcript: string;
};

export type SessionImportPlan = {
	targetCwd: string;
	sessionDir: string;
	sessionPath: string;
	workspace: "existing" | "missing";
	/** Suggested (or, with --git, executed) git commands to recreate the workspace. */
	gitAdvice: string[];
	warnings: string[];
};

const GIT_PATCH_MAX_BYTES = 8 * 1024 * 1024;
const UNTRACKED_MAX_ENTRIES = 200;
const BUNDLE_FILE_SUFFIX = ".pi-session.json";

// ---------------------------------------------------------------------------
// Pi session directory encoding (mirrors pi-coding-agent session-paths.ts)
// ---------------------------------------------------------------------------

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relativePath: string): string {
	const encoded = relativePath.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

/**
 * Compute the per-cwd session directory name pi uses under its sessions root.
 * Home-relative cwds encode as `-<rel>`, temp-relative as `-tmp-<rel>`, and
 * anything else as the legacy `--<absolute>--` form.
 */
export function encodePiSessionDirName(
	cwd: string,
	opts: { home?: string; tmp?: string } = {},
): string {
	const resolvedCwd = resolve(cwd);
	const home = opts.home ?? homedir();
	const tmp = opts.tmp ?? tmpdir();
	const homeRelative = relative(home, resolvedCwd);
	if (homeRelative === "" || (!homeRelative.startsWith("..") && !isAbsolute(homeRelative))) {
		return encodeRelativeSessionDirName("-", homeRelative);
	}
	const tempRelative = relative(tmp, resolvedCwd);
	if (tempRelative === "" || (!tempRelative.startsWith("..") && !isAbsolute(tempRelative))) {
		return encodeRelativeSessionDirName("-tmp", tempRelative);
	}
	return encodeLegacyAbsoluteSessionDirName(resolvedCwd);
}

export function getPiSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_SPEAK_SESSIONS_ROOT?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent", "sessions");
}

// ---------------------------------------------------------------------------
// Transfer directories (home-based so scp targets are predictable cross-host)
// ---------------------------------------------------------------------------

export function getSessionBundleDir(home: string = homedir()): string {
	return join(home, ".pi-speak", "session-bundles");
}

export function getSessionInboxDir(home: string = homedir()): string {
	return join(home, ".pi-speak", "session-inbox");
}

export function sanitizeBundleName(name: string): string {
	const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "session";
}

export function bundleFileName(name: string): string {
	return `${sanitizeBundleName(name)}${BUNDLE_FILE_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Git capture / restore
// ---------------------------------------------------------------------------

type GitResult = { ok: boolean; stdout: string; stderr: string };

function runGit(cwd: string | undefined, args: string[]): GitResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) return { ok: false, stdout: "", stderr: String(result.error.message || result.error) };
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Capture the git state of `cwd`. Returns no `git` field when cwd is not a repo. */
export function captureGitState(cwd: string): { git?: SessionBundleGit; warnings: string[] } {
	const warnings: string[] = [];
	const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!inside.ok || inside.stdout.trim() !== "true") {
		warnings.push(`Workspace ${cwd} is not a git repository; the bundle carries no repo state.`);
		return { warnings };
	}
	const git: SessionBundleGit = {};
	const remote = runGit(cwd, ["config", "--get", "remote.origin.url"]);
	if (remote.ok && remote.stdout.trim()) git.remote = remote.stdout.trim();
	const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch.ok && branch.stdout.trim() && branch.stdout.trim() !== "HEAD") git.branch = branch.stdout.trim();
	const head = runGit(cwd, ["rev-parse", "HEAD"]);
	if (head.ok && head.stdout.trim()) git.head = head.stdout.trim();
	const diff = runGit(cwd, ["diff", "HEAD", "--binary"]);
	if (diff.ok && diff.stdout) {
		if (Buffer.byteLength(diff.stdout, "utf8") > GIT_PATCH_MAX_BYTES) {
			warnings.push("Uncommitted diff exceeds the 8MB bundle cap; commit or stash before bundling to carry it.");
		} else if (diff.stdout.trim()) {
			git.patch = diff.stdout;
		}
	}
	const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (untracked.ok && untracked.stdout.trim()) {
		const entries = untracked.stdout.split(/\r?\n/).filter((line) => line.trim());
		git.untracked = entries.slice(0, UNTRACKED_MAX_ENTRIES);
		warnings.push(
			`${entries.length} untracked file(s) are NOT carried by the bundle (names recorded only). Commit anything you need on the other host.`,
		);
	}
	if (!git.remote) warnings.push("No origin remote configured; the target host cannot clone this workspace automatically.");
	return { git, warnings };
}

export type GitRestoreResult = { ok: boolean; steps: string[]; warnings: string[] };

/**
 * Recreate (or reconcile) the bundle's workspace at `targetCwd`.
 * - Missing cwd + remote: clone, then check out the bundle branch/commit.
 * - Existing repo: verify head, and apply the carried dirty patch when the tree is clean.
 * Never force-overwrites local work.
 */
export function restoreGitWorkspace(bundle: SessionBundle, targetCwd: string): GitRestoreResult {
	const steps: string[] = [];
	const warnings: string[] = [];
	const git = bundle.git;
	if (!git) return { ok: true, steps, warnings: ["Bundle carries no git state; nothing to restore."] };

	if (!existsSync(targetCwd)) {
		if (!git.remote) {
			return { ok: false, steps, warnings: [`${targetCwd} does not exist and the bundle has no remote to clone from.`] };
		}
		const clone = runGit(undefined, ["clone", git.remote, targetCwd]);
		if (!clone.ok) return { ok: false, steps, warnings: [`git clone failed: ${clone.stderr.trim()}`] };
		steps.push(`cloned ${git.remote} -> ${targetCwd}`);
	}

	const inside = runGit(targetCwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!inside.ok || inside.stdout.trim() !== "true") {
		return { ok: false, steps, warnings: [`${targetCwd} exists but is not a git repository.`] };
	}

	if (git.head) {
		const currentHead = runGit(targetCwd, ["rev-parse", "HEAD"]);
		if (currentHead.ok && currentHead.stdout.trim() !== git.head) {
			runGit(targetCwd, ["fetch", "--all", "--quiet"]);
			const checkoutTarget = git.branch ?? git.head;
			const checkout = runGit(targetCwd, ["checkout", checkoutTarget]);
			if (checkout.ok) {
				steps.push(`checked out ${checkoutTarget}`);
				const afterHead = runGit(targetCwd, ["rev-parse", "HEAD"]);
				if (afterHead.ok && afterHead.stdout.trim() !== git.head) {
					warnings.push(`HEAD is ${afterHead.stdout.trim().slice(0, 12)} but the bundle was made at ${git.head.slice(0, 12)}. Pull or check out the exact commit for full fidelity.`);
				}
			} else {
				warnings.push(`Could not check out ${checkoutTarget}: ${checkout.stderr.trim()}`);
			}
		}
	}

	if (git.patch) {
		const status = runGit(targetCwd, ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim()) {
			warnings.push("Target working tree is dirty; skipped applying the bundled patch. Stash local changes and re-run import with --git.");
		} else {
			const patchPath = join(tmpdir(), `pi-speak-bundle-${Date.now()}-${process.pid}.patch`);
			writeFileSync(patchPath, git.patch, "utf8");
			try {
				const apply = runGit(targetCwd, ["apply", "--3way", "--binary", patchPath]);
				if (apply.ok) steps.push("applied bundled uncommitted diff");
				else warnings.push(`git apply failed: ${apply.stderr.trim()}`);
			} finally {
				rmSync(patchPath, { force: true });
			}
		}
	}

	return { ok: true, steps, warnings };
}

// ---------------------------------------------------------------------------
// Bundle build / parse
// ---------------------------------------------------------------------------

export function createSessionBundle(input: {
	name: string;
	aliases: string[];
	sessionPath: string;
	cwd: string;
	note?: string;
	includeGit?: boolean;
}): { bundle: SessionBundle; warnings: string[] } {
	const transcript = readFileSync(input.sessionPath, "utf8");
	const warnings: string[] = [];
	let git: SessionBundleGit | undefined;
	if (input.includeGit !== false) {
		const captured = captureGitState(input.cwd);
		git = captured.git;
		warnings.push(...captured.warnings);
	}
	const bundle: SessionBundle = {
		kind: "pi-speak-session-bundle",
		version: 1,
		createdAt: Date.now(),
		name: input.name,
		aliases: [...input.aliases],
		host: { hostname: hostname(), platform: platform() },
		cwd: input.cwd,
		...(input.note ? { note: input.note } : {}),
		...(git ? { git } : {}),
		sessionFileName: basename(input.sessionPath),
		transcript,
	};
	return { bundle, warnings };
}

export function serializeSessionBundle(bundle: SessionBundle): string {
	return JSON.stringify(bundle, null, 2);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseSessionBundle(text: string): { bundle?: SessionBundle; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: "Not valid JSON." };
	}
	if (!parsed || typeof parsed !== "object") return { error: "Not a bundle object." };
	const record = parsed as Record<string, unknown>;
	if (record.kind !== "pi-speak-session-bundle") return { error: "Missing pi-speak-session-bundle marker." };
	if (record.version !== 1) return { error: `Unsupported bundle version ${String(record.version)}.` };
	const name = stringField(record.name);
	const cwd = stringField(record.cwd);
	const sessionFileName = stringField(record.sessionFileName);
	const transcript = typeof record.transcript === "string" ? record.transcript : undefined;
	if (!name || !cwd || !sessionFileName || transcript === undefined || !transcript.trim()) {
		return { error: "Bundle is missing name, cwd, sessionFileName, or transcript." };
	}
	const aliases = Array.isArray(record.aliases) ? record.aliases.filter((a): a is string => typeof a === "string") : [];
	const hostRecord = record.host && typeof record.host === "object" ? (record.host as Record<string, unknown>) : {};
	const gitRecord = record.git && typeof record.git === "object" ? (record.git as Record<string, unknown>) : undefined;
	const git: SessionBundleGit | undefined = gitRecord
		? {
			remote: stringField(gitRecord.remote),
			branch: stringField(gitRecord.branch),
			head: stringField(gitRecord.head),
			patch: typeof gitRecord.patch === "string" ? gitRecord.patch : undefined,
			untracked: Array.isArray(gitRecord.untracked)
				? gitRecord.untracked.filter((entry): entry is string => typeof entry === "string")
				: undefined,
		}
		: undefined;
	return {
		bundle: {
			kind: "pi-speak-session-bundle",
			version: 1,
			createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
			name,
			aliases,
			host: {
				hostname: stringField(hostRecord.hostname) ?? "unknown",
				platform: stringField(hostRecord.platform) ?? "unknown",
			},
			cwd,
			note: stringField(record.note),
			git,
			sessionFileName,
			transcript,
		},
	};
}

/** Rewrite the session header's cwd so pi associates the transcript with the target workspace. */
export function rewriteTranscriptCwd(transcript: string, newCwd: string): { transcript: string; rewritten: boolean } {
	const newline = transcript.indexOf("\n");
	const firstLine = (newline >= 0 ? transcript.slice(0, newline) : transcript).trim();
	const remainder = newline >= 0 ? transcript.slice(newline) : "";
	let header: unknown;
	try {
		header = JSON.parse(firstLine);
	} catch {
		return { transcript, rewritten: false };
	}
	if (!header || typeof header !== "object") return { transcript, rewritten: false };
	const record = header as Record<string, unknown>;
	let rewritten = false;
	if (typeof record.cwd === "string") {
		record.cwd = newCwd;
		rewritten = true;
	}
	const payload = record.payload;
	if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).cwd === "string") {
		(payload as Record<string, unknown>).cwd = newCwd;
		rewritten = true;
	}
	if (!rewritten) return { transcript, rewritten: false };
	return { transcript: `${JSON.stringify(record)}${remainder}`, rewritten: true };
}

// ---------------------------------------------------------------------------
// Import planning / apply
// ---------------------------------------------------------------------------

export function planSessionImport(
	bundle: SessionBundle,
	opts: {
		targetCwd?: string;
		sessionsRoot?: string;
		home?: string;
		tmp?: string;
		pathExists?: (path: string) => boolean;
	} = {},
): SessionImportPlan {
	const pathExists = opts.pathExists ?? existsSync;
	const targetCwd = resolve(opts.targetCwd?.trim() || bundle.cwd);
	const sessionsRoot = opts.sessionsRoot ?? getPiSessionsRoot();
	const sessionDir = join(sessionsRoot, encodePiSessionDirName(targetCwd, { home: opts.home, tmp: opts.tmp }));
	let fileName = bundle.sessionFileName;
	if (pathExists(join(sessionDir, fileName))) {
		const stem = fileName.replace(/\.jsonl$/i, "");
		let counter = 1;
		while (counter < 1000 && pathExists(join(sessionDir, `${stem}-imported-${counter}.jsonl`))) counter += 1;
		fileName = counter < 1000 ? `${stem}-imported-${counter}.jsonl` : `${stem}-imported-${Date.now()}.jsonl`;
	}
	const warnings: string[] = [];
	const gitAdvice: string[] = [];
	const workspace: SessionImportPlan["workspace"] = pathExists(targetCwd) ? "existing" : "missing";
	if (workspace === "missing") {
		if (bundle.git?.remote) {
			gitAdvice.push(`git clone ${bundle.git.remote} "${targetCwd}"`);
			if (bundle.git.branch) gitAdvice.push(`git -C "${targetCwd}" checkout ${bundle.git.branch}`);
			if (bundle.git.head) gitAdvice.push(`git -C "${targetCwd}" checkout ${bundle.git.head}  # exact bundle commit`);
		} else {
			warnings.push(`Workspace ${targetCwd} does not exist on this host and the bundle has no git remote. Create it manually or re-import with --cwd <path>.`);
		}
	}
	if (bundle.git?.patch) {
		gitAdvice.push("re-run import with --git to apply the bundled uncommitted diff (clean tree required)");
	}
	if (bundle.git?.untracked?.length) {
		warnings.push(`Bundle source had ${bundle.git.untracked.length} untracked file(s) that did not travel: ${bundle.git.untracked.slice(0, 5).join(", ")}${bundle.git.untracked.length > 5 ? ", …" : ""}`);
	}
	if (bundle.note) warnings.push(`Environment note from ${bundle.host.hostname}: ${bundle.note}`);
	return { targetCwd, sessionDir, sessionPath: join(sessionDir, fileName), workspace, gitAdvice, warnings };
}

export function applySessionImport(bundle: SessionBundle, plan: SessionImportPlan): { sessionPath: string; cwdRewritten: boolean } {
	mkdirSync(plan.sessionDir, { recursive: true });
	const { transcript, rewritten } = rewriteTranscriptCwd(bundle.transcript, plan.targetCwd);
	writeFileSync(plan.sessionPath, transcript, "utf8");
	return { sessionPath: plan.sessionPath, cwdRewritten: rewritten };
}

// ---------------------------------------------------------------------------
// Bundle store + inbox
// ---------------------------------------------------------------------------

export type StoredBundleInfo = {
	name: string;
	path: string;
	createdAt: number;
	host: string;
	cwd: string;
	hasGit: boolean;
	note?: string;
};

export function saveBundleToStore(bundle: SessionBundle, dir: string = getSessionBundleDir()): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, bundleFileName(bundle.name));
	writeFileSync(path, serializeSessionBundle(bundle), "utf8");
	return path;
}

export function listStoredBundles(dir: string = getSessionBundleDir()): StoredBundleInfo[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const bundles: StoredBundleInfo[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(BUNDLE_FILE_SUFFIX)) continue;
		const path = join(dir, entry);
		try {
			const { bundle } = parseSessionBundle(readFileSync(path, "utf8"));
			if (!bundle) continue;
			bundles.push({
				name: bundle.name,
				path,
				createdAt: bundle.createdAt,
				host: bundle.host.hostname,
				cwd: bundle.cwd,
				hasGit: Boolean(bundle.git),
				note: bundle.note,
			});
		} catch {
			// Unreadable file: skip.
		}
	}
	bundles.sort((a, b) => b.createdAt - a.createdAt);
	return bundles;
}

export function removeStoredBundle(name: string, dir: string = getSessionBundleDir()): boolean {
	const path = join(dir, bundleFileName(name));
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

/** Resolve an import argument: explicit file path first, then a stored-bundle name, then an inbox entry. */
export function resolveBundleSource(
	arg: string,
	opts: { bundleDir?: string; inboxDir?: string } = {},
): string | undefined {
	const direct = arg.trim();
	if (!direct) return undefined;
	if (existsSync(direct)) return resolve(direct);
	const fromStore = join(opts.bundleDir ?? getSessionBundleDir(), bundleFileName(direct));
	if (existsSync(fromStore)) return fromStore;
	const fromInbox = join(opts.inboxDir ?? getSessionInboxDir(), bundleFileName(direct));
	if (existsSync(fromInbox)) return fromInbox;
	return undefined;
}

export function listInboxBundleFiles(dir: string = getSessionInboxDir()): string[] {
	try {
		return readdirSync(dir)
			.filter((entry) => entry.endsWith(BUNDLE_FILE_SUFFIX))
			.map((entry) => join(dir, entry));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// SSH send
// ---------------------------------------------------------------------------

export type SendCommand = { command: string; args: string[] };

/**
 * Commands to push a bundle into `<host>`'s home-relative inbox. The remote
 * path is home-relative (`.pi-speak/session-inbox`) so it lands in the same
 * place `/sess pickup` scans, regardless of the remote OS layout. The remote
 * needs a POSIX shell for `mkdir -p`; pre-create the directory on Windows hosts.
 */
export function buildSendCommands(host: string, localBundlePath: string): SendCommand[] {
	return [
		{ command: "ssh", args: [host, "mkdir -p .pi-speak/session-inbox"] },
		{ command: "scp", args: [localBundlePath, `${host}:.pi-speak/session-inbox/`] },
	];
}

export function runSendCommands(commands: SendCommand[]): { ok: boolean; failedStep?: string; stderr?: string } {
	for (const step of commands) {
		const result = spawnSync(step.command, step.args, { encoding: "utf8", windowsHide: true });
		if (result.error || result.status !== 0) {
			const stderr = result.error ? String(result.error.message || result.error) : (result.stderr ?? "").trim();
			return { ok: false, failedStep: `${step.command} ${step.args.join(" ")}`, stderr };
		}
	}
	return { ok: true };
}
