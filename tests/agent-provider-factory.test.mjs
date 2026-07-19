import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createInitialAgentProviders,
	createOmpAgentProvider,
	createOmpResumeProvider,
	createTurnAgentProvider,
	ompExtensionArgs,
	resolveAgentWorkspace,
} from "../dist/agent-provider-factory.js";
import { collectAgentResponse } from "../dist/agent-provider.js";

test("omp provider passes the prompt to the CLI as a literal argv element via the safe spawn path", async () => {
	// Regression for the command-injection fix in OmpCliProvider (formerly spawned
	// with shell:true on a resolved .cmd shim on Windows, with the raw prompt in
	// argv). runCli/safeSpawn never pass `shell` at all now. The Windows-specific
	// injection-closure property (cross-spawn's caret-escaping) is covered
	// separately in tests/spawn-shim.test.mjs, since shell:true there was already
	// gated to win32 and can't be exercised on this platform; this test instead
	// confirms the refactor still threads the prompt through argv correctly.
	const tmp = mkdtempSync(join(tmpdir(), "pi-speak-omp-argv-"));
	const fakeOmpBin = join(tmp, "fake-omp.js");
	writeFileSync(
		fakeOmpBin,
		"#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
	);
	chmodSync(fakeOmpBin, 0o755);
	try {
		const evil = 'do the thing && calc.exe | echo pwned > out.txt ^ "quoted" % PATH %';
		const provider = createOmpAgentProvider(fakeOmpBin, tmp, { ...process.env, AGENT_TURN_TIMEOUT_MS: "10000" });
		const text = await collectAgentResponse(provider, evil);
		const argv = JSON.parse(text);
		assert.equal(argv[argv.length - 1], evil);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("omp resume provider rejects on a failing CLI — feeds runCodingAgentTurn's onPrimaryFailure (H3)", async () => {
	// A bogus omp binary makes runCli reject (spawn error or non-zero exit), which
	// propagates out of collectAgentResponse. This is the real reject->throw chain
	// that triggers the omp selection clear in runCodingAgentTurn; no mock seam.
	const provider = createOmpResumeProvider(
		"pi-speak-nonexistent-omp-binary-xyz",
		process.cwd(),
		"/no/such/session.jsonl",
		{ ...process.env, AGENT_TURN_TIMEOUT_MS: "4000" },
	);
	await assert.rejects(() => collectAgentResponse(provider, "hello"));
});

test("ompExtensionArgs defaults OFF (M2: no blanket capability stripping)", () => {
	assert.deepEqual(ompExtensionArgs({}), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMPK_NO_EXTENSIONS: "" }), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMPK_NO_EXTENSIONS: "0" }), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "" }), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "0" }), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "false" }), []);
});

test("ompExtensionArgs opts in via env (M1: consistent across providers)", () => {
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMPK_NO_EXTENSIONS: "1" }), ["--no-extensions"]);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMPK_NO_EXTENSIONS: "true" }), ["--no-extensions"]);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "1" }), ["--no-extensions"]);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "true" }), ["--no-extensions"]);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "YES" }), ["--no-extensions"]);
});

const baseConfig = {
	provider: "codex",
	codexBin: "codex-test",
	claudeBin: "claude-test",
	piBin: "pi-test",
	ompBin: "omp-test",
	model: "model-test",
	approvalPolicy: "never",
	sandbox: "danger-full-access",
};

test("agent provider factory creates Codex with Pi fallback by default", () => {
	const created = createInitialAgentProviders({
		config: baseConfig,
		env: {},
		cwd: "C:\\repo",
	});
	assert.equal(created.provider.name, "codex");
	assert.equal(created.fallbackProvider?.name, "pi");
});

test("agent provider factory honors coding backend override for ElevenLabs mode", () => {
	const created = createInitialAgentProviders({
		config: { ...baseConfig, provider: "elevenlabs" },
		env: { PI_SPEAK_AGENT_BACKEND: "claude" },
		cwd: "C:\\repo",
	});
	assert.equal(created.provider.name, "claude");
	assert.equal(created.fallbackProvider, undefined);
});

test("agent provider factory creates an oh-my-pk provider when configured", () => {
	const created = createInitialAgentProviders({
		config: { ...baseConfig, provider: "oh-my-pk" },
		env: {},
		cwd: "C:\\repo",
	});
	assert.equal(created.provider.name, "oh-my-pk");
	assert.equal(created.fallbackProvider, undefined);
});

test("agent provider factory resolves oh-my-pk coding backend from new and legacy aliases", () => {
	const created = createInitialAgentProviders({
		config: { ...baseConfig, provider: "elevenlabs" },
		env: { PI_SPEAK_AGENT_BACKEND: "ompk" },
		cwd: "C:\\repo",
	});
	assert.equal(created.provider.name, "oh-my-pk");
	const legacy = createInitialAgentProviders({
		config: { ...baseConfig, provider: "elevenlabs" },
		env: { PI_SPEAK_AGENT_BACKEND: "omp" },
		cwd: "C:\\repo",
	});
	assert.equal(legacy.provider.name, "oh-my-pk");
	assert.equal(created.fallbackProvider, undefined);
});

test("agent provider factory creates a fresh oh-my-pk provider for the routed backend", () => {
	const fresh = createTurnAgentProvider({
		config: baseConfig,
		env: {},
		backend: "oh-my-pk",
		cwd: "C:\\repo",
	});
	assert.equal(fresh.provider.name, "oh-my-pk");
	assert.equal(fresh.stopAfterTurn, true);
	assert.equal(fresh.source, "fresh");
});

test("createOmpAgentProvider returns a provider named oh-my-pk", () => {
	const provider = createOmpAgentProvider("omp-test", "C:\\repo", {});
	assert.equal(provider.name, "oh-my-pk");
	assert.equal(typeof provider.sendPrompt, "function");
});

test("agent provider factory reuses shared and fallback providers when requested", () => {
	const sharedProvider = { name: "claude", async *sendPrompt() {} };
	const fallbackProvider = { name: "pi", async *sendPrompt() {} };
	const shared = createTurnAgentProvider({
		config: baseConfig,
		env: {},
		backend: "claude",
		cwd: "C:\\repo",
		preferShared: true,
		sharedProvider,
		fallbackProvider,
	});
	assert.equal(shared.provider, sharedProvider);
	assert.equal(shared.stopAfterTurn, false);
	assert.equal(shared.source, "shared");

	const fallback = createTurnAgentProvider({
		config: baseConfig,
		env: {},
		backend: "pi",
		cwd: "C:\\repo",
		preferShared: true,
		sharedProvider,
		fallbackProvider,
	});
	assert.equal(fallback.provider, fallbackProvider);
	assert.equal(fallback.stopAfterTurn, false);
	assert.equal(fallback.source, "fallback");
});

test("agent provider factory creates one-shot resume providers for routed targets", () => {
	const codex = createTurnAgentProvider({
		config: baseConfig,
		env: {},
		backend: "codex",
		cwd: "C:\\repo",
		target: {
			target: "codex:resume:abc123 repo",
			provider: "codex",
			sessionId: "abc123",
			sessionPath: "C:\\sessions\\abc123.jsonl",
			cwd: "C:\\repo",
			launchedAt: 1,
		},
	});
	assert.equal(codex.provider.name, "codex");
	assert.equal(codex.stopAfterTurn, true);
	assert.equal(codex.source, "resume");

	const claude = createTurnAgentProvider({
		config: baseConfig,
		env: {},
		backend: "claude",
		cwd: "C:\\repo",
		target: {
			target: "claude:resume:3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad repo",
			provider: "claude",
			sessionId: "3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad",
			sessionPath: "C:\\sessions\\claude.jsonl",
			cwd: "C:\\repo",
			launchedAt: 1,
		},
	});
	assert.equal(claude.provider.name, "claude");
	assert.equal(claude.stopAfterTurn, true);
	assert.equal(claude.source, "resume");
});

test("agent provider factory resolves workspace from env before caller cwd", () => {
	assert.equal(resolveAgentWorkspace({
		config: baseConfig,
		env: { AGENT_WORKSPACE: "C:\\env-repo" },
		cwd: "C:\\caller-repo",
	}), "C:\\env-repo");
});
