import test from "node:test";
import assert from "node:assert/strict";
import {
	createInitialAgentProviders,
	createOmpAgentProvider,
	createTurnAgentProvider,
	ompExtensionArgs,
	resolveAgentWorkspace,
} from "../dist/agent-provider-factory.js";

test("ompExtensionArgs defaults OFF (M2: no blanket capability stripping)", () => {
	assert.deepEqual(ompExtensionArgs({}), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "" }), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "0" }), []);
	assert.deepEqual(ompExtensionArgs({ PI_SPEAK_OMP_NO_EXTENSIONS: "false" }), []);
});

test("ompExtensionArgs opts in via env (M1: consistent across providers)", () => {
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

test("agent provider factory creates an oh-my-pi provider when configured", () => {
	const created = createInitialAgentProviders({
		config: { ...baseConfig, provider: "oh-my-pi" },
		env: {},
		cwd: "C:\\repo",
	});
	assert.equal(created.provider.name, "oh-my-pi");
	assert.equal(created.fallbackProvider, undefined);
});

test("agent provider factory resolves oh-my-pi coding backend from the omp alias", () => {
	const created = createInitialAgentProviders({
		config: { ...baseConfig, provider: "elevenlabs" },
		env: { PI_SPEAK_AGENT_BACKEND: "omp" },
		cwd: "C:\\repo",
	});
	assert.equal(created.provider.name, "oh-my-pi");
	assert.equal(created.fallbackProvider, undefined);
});

test("agent provider factory creates a fresh oh-my-pi provider for the routed backend", () => {
	const fresh = createTurnAgentProvider({
		config: baseConfig,
		env: {},
		backend: "oh-my-pi",
		cwd: "C:\\repo",
	});
	assert.equal(fresh.provider.name, "oh-my-pi");
	assert.equal(fresh.stopAfterTurn, true);
	assert.equal(fresh.source, "fresh");
});

test("createOmpAgentProvider returns a provider named oh-my-pi", () => {
	const provider = createOmpAgentProvider("omp-test", "C:\\repo", {});
	assert.equal(provider.name, "oh-my-pi");
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
