import test from "node:test";
import assert from "node:assert/strict";
import { planConversationExecution } from "../dist/conversation-execution-router.js";

function summary(actionItems = ["inspect project status"]) {
	return {
		goal: "Handle a remote operator request",
		actionItems,
		constraints: [],
		deferredReminders: [],
		doNotDo: [],
		unknowns: [],
		discarded: [],
		confidence: 0.8,
		shouldDispatch: true,
		clarifyingQuestion: undefined,
		engine: "heuristic",
	};
}

async function withEnv(patch, run) {
	const previous = {};
	for (const key of Object.keys(patch)) {
		previous[key] = process.env[key];
		const value = patch[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("execution router honors explicit AGENT_PROVIDER=codex when no router override is set", async () => {
	await withEnv({ AGENT_PROVIDER: "codex", PI_SPEAK_EXECUTION_ROUTER_MODE: undefined }, async () => {
		const plan = planConversationExecution(summary(["inspect status"]));
		assert.equal(plan.dispatch, true);
		assert.equal(plan.backend, "codex");
		assert.equal(plan.reason, "dispatch-codex");
	});
});

test("execution router override wins over AGENT_PROVIDER", async () => {
	await withEnv({ AGENT_PROVIDER: "codex", PI_SPEAK_EXECUTION_ROUTER_MODE: "pi" }, async () => {
		const plan = planConversationExecution(summary(["edit source files"]));
		assert.equal(plan.dispatch, true);
		assert.equal(plan.backend, "pi");
		assert.equal(plan.reason, "dispatch-pi");
	});
});

test("execution router auto mode preserves keyword routing even with AGENT_PROVIDER set", async () => {
	await withEnv({ AGENT_PROVIDER: "pi", PI_SPEAK_EXECUTION_ROUTER_MODE: "auto" }, async () => {
		const plan = planConversationExecution(summary(["fix the TypeScript build"]));
		assert.equal(plan.dispatch, true);
		assert.equal(plan.backend, "codex");
		assert.equal(plan.reason, "dispatch-codex");
	});
});

test("execution router honors an explicit provider override for dispatchable turns", async () => {
	await withEnv({ AGENT_PROVIDER: "pi", PI_SPEAK_EXECUTION_ROUTER_MODE: "codex" }, async () => {
		const plan = planConversationExecution(summary(["inspect the repo"]), {
			provider: "pi",
		});
		assert.equal(plan.dispatch, true);
		assert.equal(plan.backend, "pi");
		assert.equal(plan.reason, "dispatch-pi");
	});
});

test("execution router marks routine Pi work as fast-plus-tools", async () => {
	const plan = planConversationExecution(summary(["inspect current status"]));
	assert.equal(plan.dispatch, true);
	assert.equal(plan.backend, "pi");
	assert.equal(plan.routeClass, "fast-plus-tools");
	assert.equal(plan.costTier, "T1");
	assert.equal(plan.riskLevel, "low");
	assert.equal(plan.userAck, undefined);
});

test("execution router marks file-changing Codex work as slow-think with user ack", async () => {
	const plan = planConversationExecution(summary(["fix the Android session dashboard wiring"]));
	assert.equal(plan.dispatch, true);
	assert.equal(plan.backend, "codex");
	assert.equal(plan.routeClass, "slow-think");
	assert.equal(plan.costTier, "T2");
	assert.equal(plan.riskLevel, "medium");
	assert.match(plan.userAck, /think for a minute/);
	assert.match(plan.userProgress, /think for a minute/);
	assert.match(plan.escalationReason, /file-changing coding workflow/);
});

test("execution router marks destructive work as high risk", async () => {
	const plan = planConversationExecution(summary(["delete the production token file"]));
	assert.equal(plan.routeClass, "slow-think");
	assert.equal(plan.riskLevel, "high");
	assert.equal(plan.costTier, "T3");
	assert.match(plan.escalationReason, /risk signal/);
});

test("execution router marks clarify cases as fast triage", async () => {
	const plan = planConversationExecution({
		...summary([]),
		confidence: 0.2,
		shouldDispatch: false,
		clarifyingQuestion: "What should I change?",
	});
	assert.equal(plan.dispatch, false);
	assert.equal(plan.reason, "clarify");
	assert.equal(plan.routeClass, "fast");
	assert.equal(plan.costTier, "T0");
	assert.equal(plan.latencyBudgetMs, 50);
});
