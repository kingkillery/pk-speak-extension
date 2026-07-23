import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
	applySessionImport,
	buildSendCommands,
	bundleFileName,
	captureGitState,
	createSessionBundle,
	encodePiSessionDirName,
	listStoredBundles,
	parseSessionBundle,
	planSessionImport,
	removeStoredBundle,
	resolveBundleSource,
	restoreGitWorkspace,
	rewriteTranscriptCwd,
	sanitizeBundleName,
	saveBundleToStore,
	serializeSessionBundle,
} from "../dist/session-transfer.js";

const SESSION_HEADER = { type: "session", version: 3, id: "test-id", timestamp: "2026-07-22T00:00:00.000Z", cwd: "C:\\src\\proj" };

function makeTranscript(cwd = SESSION_HEADER.cwd) {
	return [
		JSON.stringify({ ...SESSION_HEADER, cwd }),
		JSON.stringify({ type: "model_change", id: "m1", provider: "kimi" }),
		"",
	].join("\n");
}

function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Session directory encoding
// ---------------------------------------------------------------------------

test("encodePiSessionDirName encodes home-relative cwds with a leading dash", () => {
	const home = resolve(sep, "users", "alice");
	const cwd = join(home, "dev", "proj");
	assert.equal(encodePiSessionDirName(cwd, { home, tmp: resolve(sep, "faketmp") }), "-dev-proj");
	assert.equal(encodePiSessionDirName(home, { home, tmp: resolve(sep, "faketmp") }), "-");
});

test("encodePiSessionDirName encodes temp-relative cwds under -tmp", () => {
	const home = resolve(sep, "users", "alice");
	const tmp = resolve(sep, "vartmp");
	assert.equal(encodePiSessionDirName(join(tmp, "job"), { home, tmp }), "-tmp-job");
});

test("encodePiSessionDirName falls back to the legacy --absolute-- form", () => {
	const home = resolve(sep, "users", "alice");
	const tmp = resolve(sep, "vartmp");
	const cwd = resolve(sep, "srv", "code", "proj");
	const encoded = encodePiSessionDirName(cwd, { home, tmp });
	assert.ok(encoded.startsWith("--"), `expected --wrapper, got ${encoded}`);
	assert.ok(encoded.endsWith("--"), `expected --wrapper, got ${encoded}`);
	assert.ok(!encoded.slice(2, -2).includes(sep), "separators must be encoded away");
});

test("encodePiSessionDirName matches the observed pi layout on Windows", { skip: process.platform !== "win32" }, () => {
	const encoded = encodePiSessionDirName("C:\\dev\\Desktop-Projects\\pi-speak-extension", {
		home: "C:\\Users\\alice",
		tmp: "C:\\Users\\alice\\AppData\\Local\\Temp",
	});
	assert.equal(encoded, "--C--dev-Desktop-Projects-pi-speak-extension--");
});

// ---------------------------------------------------------------------------
// Bundle build / parse round trip
// ---------------------------------------------------------------------------

test("createSessionBundle + parseSessionBundle round-trips", () => {
	const dir = tempDir("pi-speak-bundle-");
	try {
		const sessionPath = join(dir, "sess.jsonl");
		writeFileSync(sessionPath, makeTranscript(), "utf8");
		const { bundle } = createSessionBundle({
			name: "voice-work",
			aliases: ["one"],
			sessionPath,
			cwd: dir,
			note: "needs Chrome open",
			includeGit: false,
		});
		const parsed = parseSessionBundle(serializeSessionBundle(bundle));
		assert.ok(parsed.bundle, parsed.error);
		assert.equal(parsed.bundle.name, "voice-work");
		assert.deepEqual(parsed.bundle.aliases, ["one"]);
		assert.equal(parsed.bundle.cwd, dir);
		assert.equal(parsed.bundle.note, "needs Chrome open");
		assert.equal(parsed.bundle.sessionFileName, "sess.jsonl");
		assert.equal(parsed.bundle.transcript, makeTranscript());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseSessionBundle rejects malformed input", () => {
	assert.ok(parseSessionBundle("not json").error);
	assert.ok(parseSessionBundle(JSON.stringify({ kind: "other" })).error);
	assert.ok(parseSessionBundle(JSON.stringify({ kind: "pi-speak-session-bundle", version: 2 })).error);
	assert.ok(parseSessionBundle(JSON.stringify({ kind: "pi-speak-session-bundle", version: 1, name: "x" })).error);
});

// ---------------------------------------------------------------------------
// Transcript cwd rewrite
// ---------------------------------------------------------------------------

test("rewriteTranscriptCwd rewrites only the header line", () => {
	const transcript = makeTranscript("C:\\old\\place");
	const { transcript: rewritten, rewritten: ok } = rewriteTranscriptCwd(transcript, "/new/place");
	assert.ok(ok);
	const [headerLine, secondLine] = rewritten.split("\n");
	assert.equal(JSON.parse(headerLine).cwd, "/new/place");
	assert.equal(secondLine, transcript.split("\n")[1]);
});

test("rewriteTranscriptCwd leaves non-JSON headers untouched", () => {
	const result = rewriteTranscriptCwd("garbage first line\n{}", "/x");
	assert.equal(result.rewritten, false);
	assert.equal(result.transcript, "garbage first line\n{}");
});

// ---------------------------------------------------------------------------
// Import planning + apply
// ---------------------------------------------------------------------------

function fixtureBundle(overrides = {}) {
	return {
		kind: "pi-speak-session-bundle",
		version: 1,
		createdAt: 123,
		name: "voice-work",
		aliases: [],
		host: { hostname: "src-host", platform: "win32" },
		cwd: resolve(sep, "users", "alice", "dev", "proj"),
		sessionFileName: "sess.jsonl",
		transcript: makeTranscript(),
		...overrides,
	};
}

test("planSessionImport places the session in the encoded dir for the target cwd", () => {
	const home = resolve(sep, "users", "alice");
	const bundle = fixtureBundle();
	const plan = planSessionImport(bundle, {
		sessionsRoot: resolve(sep, "root", "sessions"),
		home,
		tmp: resolve(sep, "vartmp"),
		pathExists: (path) => path === bundle.cwd,
	});
	assert.equal(plan.workspace, "existing");
	assert.equal(plan.sessionDir, join(resolve(sep, "root", "sessions"), "-dev-proj"));
	assert.equal(plan.sessionPath, join(plan.sessionDir, "sess.jsonl"));
});

test("planSessionImport suffixes colliding session file names", () => {
	const home = resolve(sep, "users", "alice");
	const bundle = fixtureBundle();
	const sessionsRoot = resolve(sep, "root", "sessions");
	const taken = new Set([
		bundle.cwd,
		join(sessionsRoot, "-dev-proj", "sess.jsonl"),
		join(sessionsRoot, "-dev-proj", "sess-imported-1.jsonl"),
	]);
	const plan = planSessionImport(bundle, {
		sessionsRoot,
		home,
		tmp: resolve(sep, "vartmp"),
		pathExists: (path) => taken.has(path),
	});
	assert.equal(plan.sessionPath, join(sessionsRoot, "-dev-proj", "sess-imported-2.jsonl"));
});

test("planSessionImport advises cloning when the workspace is missing", () => {
	const bundle = fixtureBundle({ git: { remote: "https://example.com/repo.git", branch: "main", head: "a".repeat(40) } });
	const plan = planSessionImport(bundle, {
		sessionsRoot: resolve(sep, "root", "sessions"),
		home: resolve(sep, "users", "alice"),
		tmp: resolve(sep, "vartmp"),
		pathExists: () => false,
	});
	assert.equal(plan.workspace, "missing");
	assert.ok(plan.gitAdvice.some((line) => line.startsWith("git clone https://example.com/repo.git")));
});

test("planSessionImport surfaces the environment note", () => {
	const bundle = fixtureBundle({ note: "keep Chrome open with the dev profile" });
	const plan = planSessionImport(bundle, {
		sessionsRoot: resolve(sep, "root", "sessions"),
		home: resolve(sep, "users", "alice"),
		tmp: resolve(sep, "vartmp"),
		pathExists: (path) => path === bundle.cwd,
	});
	assert.ok(plan.warnings.some((line) => line.includes("keep Chrome open with the dev profile")));
});

test("applySessionImport writes the transcript with a rewritten header cwd", () => {
	const root = tempDir("pi-speak-import-");
	try {
		const targetCwd = join(root, "workspace");
		mkdirSync(targetCwd, { recursive: true });
		const bundle = fixtureBundle({ cwd: targetCwd });
		const plan = planSessionImport(bundle, { sessionsRoot: join(root, "sessions"), home: root, tmp: join(root, "tmp") });
		const applied = applySessionImport(bundle, plan);
		assert.ok(applied.cwdRewritten);
		const header = JSON.parse(readFileSync(applied.sessionPath, "utf8").split("\n")[0]);
		assert.equal(header.cwd, plan.targetCwd);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Git capture + restore (end to end against real git)
// ---------------------------------------------------------------------------

test("git state travels: capture on host A, clone + patch on host B", () => {
	const root = tempDir("pi-speak-git-");
	try {
		const repoA = join(root, "repo-a");
		mkdirSync(repoA);
		git(repoA, "init", "--initial-branch=main");
		git(repoA, "config", "user.email", "test@example.com");
		git(repoA, "config", "user.name", "Test");
		writeFileSync(join(repoA, "notes.txt"), "committed line\n", "utf8");
		git(repoA, "add", ".");
		git(repoA, "commit", "-m", "initial");
		git(repoA, "remote", "add", "origin", repoA);
		writeFileSync(join(repoA, "notes.txt"), "committed line\nuncommitted line\n", "utf8");

		const captured = captureGitState(repoA);
		assert.ok(captured.git, "expected git state");
		assert.equal(captured.git.branch, "main");
		assert.equal(captured.git.head, git(repoA, "rev-parse", "HEAD"));
		assert.ok(captured.git.patch.includes("uncommitted line"));

		const sessionPath = join(repoA, "sess.jsonl");
		writeFileSync(sessionPath, makeTranscript(repoA), "utf8");
		const bundle = {
			...fixtureBundle({ cwd: repoA }),
			git: captured.git,
		};

		const repoB = join(root, "repo-b");
		const restore = restoreGitWorkspace(bundle, repoB);
		assert.ok(restore.ok, restore.warnings.join("; "));
		assert.ok(restore.steps.some((step) => step.startsWith("cloned")));
		assert.ok(restore.steps.includes("applied bundled uncommitted diff"), restore.warnings.join("; "));
		assert.equal(
			readFileSync(join(repoB, "notes.txt"), "utf8").replace(/\r\n/g, "\n"),
			"committed line\nuncommitted line\n",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("restoreGitWorkspace refuses to patch a dirty target tree", () => {
	const root = tempDir("pi-speak-git-dirty-");
	try {
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "--initial-branch=main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		writeFileSync(join(repo, "a.txt"), "base\n", "utf8");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "initial");
		const head = git(repo, "rev-parse", "HEAD");
		writeFileSync(join(repo, "a.txt"), "local edit\n", "utf8");

		const bundle = fixtureBundle({
			cwd: repo,
			git: { head, branch: "main", patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-base\n+bundled edit\n" },
		});
		const restore = restoreGitWorkspace(bundle, repo);
		assert.ok(restore.ok);
		assert.ok(restore.warnings.some((line) => line.includes("dirty")));
		assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "local edit\n", "local work must not be overwritten");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Bundle store, inbox resolution, send plan
// ---------------------------------------------------------------------------

test("bundle store saves, lists, resolves, and removes by name", () => {
	const dir = tempDir("pi-speak-store-");
	try {
		const bundle = fixtureBundle({ name: "Voice Work!" });
		const savedPath = saveBundleToStore(bundle, dir);
		assert.equal(savedPath, join(dir, bundleFileName("Voice Work!")));
		assert.ok(existsSync(savedPath));

		const listed = listStoredBundles(dir);
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, "Voice Work!");
		assert.equal(listed[0].host, "src-host");

		assert.equal(resolveBundleSource("Voice Work!", { bundleDir: dir, inboxDir: join(dir, "none") }), savedPath);
		assert.equal(resolveBundleSource(savedPath, { bundleDir: join(dir, "none"), inboxDir: join(dir, "none") }), savedPath);
		assert.equal(resolveBundleSource("missing", { bundleDir: dir, inboxDir: dir }), undefined);

		assert.equal(removeStoredBundle("Voice Work!", dir), true);
		assert.equal(removeStoredBundle("Voice Work!", dir), false);
		assert.equal(listStoredBundles(dir).length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sanitizeBundleName produces safe file stems", () => {
	assert.equal(sanitizeBundleName("Voice Work!"), "voice-work");
	assert.equal(sanitizeBundleName("  ??? "), "session");
	assert.equal(sanitizeBundleName("a.b_c-d"), "a.b_c-d");
});

test("buildSendCommands targets the home-relative inbox", () => {
	const commands = buildSendCommands("mac-mini", "C:\\bundles\\x.pi-session.json");
	assert.deepEqual(commands[0], { command: "ssh", args: ["mac-mini", "mkdir -p .pi-speak/session-inbox"] });
	assert.deepEqual(commands[1], { command: "scp", args: ["C:\\bundles\\x.pi-session.json", "mac-mini:.pi-speak/session-inbox/"] });
});

// ---------------------------------------------------------------------------
// Provider-aware placement (claude / codex native stores)
// ---------------------------------------------------------------------------

test("encodeClaudeProjectDirName dashes every non-alphanumeric character", async () => {
	const { encodeClaudeProjectDirName } = await import("../dist/session-transfer.js");
	if (process.platform === "win32") {
		assert.equal(encodeClaudeProjectDirName("C:\\dev\\Desktop-Projects\\.graphtree\\parity-p2"), "C--dev-Desktop-Projects--graphtree-parity-p2");
	} else {
		assert.equal(encodeClaudeProjectDirName("/Users/k/dev/proj.x"), "-Users-k-dev-proj-x");
	}
});

test("planSessionImport places claude bundles under the claude projects root without cwd rewrite", async () => {
	const { planSessionImport } = await import("../dist/session-transfer.js");
	const bundle = fixtureBundle({ provider: "claude", sessionFileName: "abc123.jsonl" });
	const claudeRoot = resolve(sep, "home", "k", ".claude", "projects");
	const plan = planSessionImport(bundle, { claudeRoot, pathExists: () => false });
	assert.equal(plan.provider, "claude");
	assert.equal(plan.rewriteCwd, false);
	assert.ok(plan.sessionDir.startsWith(claudeRoot), plan.sessionDir);
	assert.ok(!plan.sessionDir.slice(claudeRoot.length + 1).includes(sep), "claude project dir must be a single encoded segment");
	assert.ok(plan.sessionPath.endsWith("abc123.jsonl"));
});

test("planSessionImport places codex bundles under the rollout date tree", async () => {
	const { planSessionImport } = await import("../dist/session-transfer.js");
	const bundle = fixtureBundle({
		provider: "codex",
		sessionFileName: "rollout-2026-07-22T13-42-20-019f8b59-b73f-7e82-814f-ced9db05f4b6.jsonl",
	});
	const codexRoot = resolve(sep, "home", "k", ".codex", "sessions");
	const plan = planSessionImport(bundle, { codexRoot, pathExists: () => false });
	assert.equal(plan.sessionDir, join(codexRoot, "2026", "07", "22"));
	assert.equal(plan.rewriteCwd, false);
});

test("applySessionImport leaves claude transcripts byte-identical", async () => {
	const { planSessionImport, applySessionImport } = await import("../dist/session-transfer.js");
	const root = tempDir("pi-speak-claude-");
	try {
		const bundle = fixtureBundle({ provider: "claude", cwd: join(root, "ws") });
		mkdirSync(join(root, "ws"), { recursive: true });
		const plan = planSessionImport(bundle, { claudeRoot: join(root, "projects") });
		const applied = applySessionImport(bundle, plan);
		assert.equal(applied.cwdRewritten, false);
		assert.equal(readFileSync(applied.sessionPath, "utf8"), bundle.transcript);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parseSessionBundle defaults provider to pi for pre-provider bundles", () => {
	const legacy = { ...fixtureBundle() };
	delete legacy.provider;
	const parsed = parseSessionBundle(JSON.stringify(legacy));
	assert.ok(parsed.bundle, parsed.error);
	assert.equal(parsed.bundle.provider, "pi");
});

test("normalizeSessionProvider maps discovery labels onto transferable providers", async () => {
	const { normalizeSessionProvider } = await import("../dist/session-transfer.js");
	assert.equal(normalizeSessionProvider("ompk"), "pi");
	assert.equal(normalizeSessionProvider("oh-my-pi"), "pi");
	assert.equal(normalizeSessionProvider(undefined), "pi");
	assert.equal(normalizeSessionProvider("Claude"), "claude");
	assert.equal(normalizeSessionProvider("codex"), "codex");
	assert.equal(normalizeSessionProvider("antigravity"), undefined);
});

test("getTransferHosts parses comma/space separated host lists", async () => {
	const { getTransferHosts } = await import("../dist/session-transfer.js");
	assert.deepEqual(getTransferHosts({ PI_SPEAK_TRANSFER_HOSTS: "gcloud-vm, mac" }), ["gcloud-vm", "mac"]);
	assert.deepEqual(getTransferHosts({ PI_SPEAK_TRANSFER_HOSTS: "one two;three,two" }), ["one", "two", "three"]);
	assert.deepEqual(getTransferHosts({}), []);
});

test("runSendCommandsAsync reports the failing step", async () => {
	const { runSendCommandsAsync } = await import("../dist/session-transfer.js");
	const result = await runSendCommandsAsync([
		{ command: "git", args: ["--version"] },
		{ command: "git", args: ["definitely-not-a-real-subcommand"] },
	]);
	assert.equal(result.ok, false);
	assert.ok(result.failedStep.includes("definitely-not-a-real-subcommand"));
});
