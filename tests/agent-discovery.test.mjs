import test from "node:test";
import assert from "node:assert/strict";

const { discoverAgentInventory, discoverOpenAgentTargets } = await import("../dist/agent-discovery.js");

test("discoverOpenAgentTargets returns an array", () => {
	const agents = discoverOpenAgentTargets();
	assert.ok(Array.isArray(agents));
});

test("discoverOpenAgentTargets returns empty array on non-Windows", () => {
	if (process.platform === "win32") {
		// On Windows the result depends on running processes; just verify array shape.
		const agents = discoverOpenAgentTargets();
		assert.ok(Array.isArray(agents));
		for (const a of agents) {
			assert.equal(typeof a, "string");
		}
	} else {
		assert.deepEqual(discoverOpenAgentTargets(), []);
	}
});

test("discoverAgentInventory returns structured running and recent session collections", () => {
	const snapshot = discoverAgentInventory({ recentLimit: 2 });
	assert.equal(typeof snapshot.generatedAt, "string");
	assert.ok(Array.isArray(snapshot.targets));
	assert.ok(Array.isArray(snapshot.running));
	assert.ok(Array.isArray(snapshot.recent));
	for (const agent of snapshot.running) {
		assert.equal(typeof agent.provider, "string");
		assert.equal(typeof agent.pid, "number");
		assert.equal(typeof agent.target, "string");
		assert.equal(agent.source, "process");
	}
	for (const session of snapshot.recent) {
		assert.equal(typeof session.provider, "string");
		assert.equal(typeof session.path, "string");
	}
});
