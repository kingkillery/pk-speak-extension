import test from "node:test";
import assert from "node:assert/strict";

const routing = await import("../dist/headless-gateway-routing.js");

test("normalizeGatewayProviderOverride accepts only runnable gateway providers", () => {
	assert.equal(routing.normalizeGatewayProviderOverride("pi"), "pi");
	assert.equal(routing.normalizeGatewayProviderOverride(" CODEX "), "codex");
	assert.equal(routing.normalizeGatewayProviderOverride("claude"), "claude");
	assert.equal(routing.normalizeGatewayProviderOverride(undefined), undefined);
});

test("buildResumeRouteTarget creates a stable resumed Codex target", () => {
	const target = routing.buildResumeRouteTarget({
		provider: "codex",
		sessionId: "abc123456789",
		sessionPath: "C:\\Users\\prest\\.codex\\sessions\\abc123456789.jsonl",
		title: "Codex: pi-speak-extension",
		cwd: "C:\\dev\\Desktop-Projects\\pi-speak-extension",
		cwdBasename: "pi-speak-extension",
		now: 1234,
	});
	assert.deepEqual(target, {
		target: "codex:resume:abc123456789 Codex: pi-speak-extension",
		provider: "codex",
		sessionId: "abc123456789",
		sessionPath: "C:\\Users\\prest\\.codex\\sessions\\abc123456789.jsonl",
		cwd: "C:\\dev\\Desktop-Projects\\pi-speak-extension",
		title: "Codex: pi-speak-extension",
		launchedAt: 1234,
	});
});

test("buildResumeRouteTarget creates a routed Claude resume target", () => {
	const target = routing.buildResumeRouteTarget({
		provider: "claude",
		sessionId: "3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad",
		sessionPath: "C:\\Users\\prest\\.claude\\projects\\session.jsonl",
		cwdBasename: "pi-speak-extension",
		now: 1234,
	});
	assert.deepEqual(target, {
		target: "claude:resume:3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad pi-speak-extension",
		provider: "claude",
		sessionId: "3b9f36cc-d3b7-4bbf-b5f2-fd46664d1bad",
		sessionPath: "C:\\Users\\prest\\.claude\\projects\\session.jsonl",
		cwd: undefined,
		title: undefined,
		launchedAt: 1234,
	});
});

test("resolveRequestedRouteTarget prefers explicit target, then default target", () => {
	const alpha = routing.buildResumeRouteTarget({
		provider: "codex",
		sessionId: "alpha-session",
		sessionPath: "C:\\sessions\\alpha.jsonl",
		now: 1,
	});
	const beta = routing.buildResumeRouteTarget({
		provider: "pi",
		sessionId: "beta-session",
		sessionPath: "C:\\sessions\\beta.jsonl",
		now: 2,
	});
	assert.ok(alpha);
	assert.ok(beta);
	const resumedTargets = new Map([
		[alpha.target, alpha],
		[beta.target, beta],
	]);
	assert.equal(routing.resolveRequestedRouteTarget({
		requestedTarget: beta.target,
		defaultTarget: alpha.target,
		resumedTargets,
	}), beta);
	assert.equal(routing.resolveRequestedRouteTarget({
		requestedTarget: "missing",
		defaultTarget: alpha.target,
		resumedTargets,
	}), alpha);
	assert.equal(routing.resolveRequestedRouteTarget({
		requestedTarget: "missing",
		defaultTarget: "also-missing",
		resumedTargets,
	}), undefined);
});
