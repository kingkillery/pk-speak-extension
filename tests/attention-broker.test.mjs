import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function withBrokerRoot(run) {
	const originalLocalAppData = process.env.LOCALAPPDATA;
	const root = mkdtempSync(join(tmpdir(), "pi-speak-attn-"));
	process.env.LOCALAPPDATA = root;
	try {
		return await run(root);
	} finally {
		if (typeof originalLocalAppData === "string") process.env.LOCALAPPDATA = originalLocalAppData;
		else delete process.env.LOCALAPPDATA;
		rmSync(root, { recursive: true, force: true });
	}
}

test("attention broker stores and lists ready sessions", async () => {
	await withBrokerRoot(async () => {
		const broker = await import(`../dist/attention-broker.js?test=${Date.now()}`);
		const sessionId = broker.buildAttentionSessionId("/sessions/alpha.jsonl", 111);
		broker.writeAttentionSnapshot({
			sessionId,
			sessionName: "Alpha",
			sessionPath: "/sessions/alpha.jsonl",
			pid: 111,
			phase: "ready",
			waitingForAttention: true,
			lastAssistantText: "Done.",
			voiceTarget: undefined,
			aliases: ["one"],
			updatedAt: Date.now(),
		});
		assert.equal(broker.listReadyAttentionSessions().length, 1);
		assert.equal(broker.updateAttentionWaitingState(sessionId, false), true);
		assert.equal(broker.listReadyAttentionSessions().length, 0);
	});
});

test("attention broker leader lease is exclusive until released", async () => {
	await withBrokerRoot(async () => {
		const broker = await import(`../dist/attention-broker.js?test=${Date.now()}-lease`);
		assert.equal(broker.claimAttentionLeader("alpha", 111), true);
		assert.equal(broker.claimAttentionLeader("beta", 222), false);
		broker.releaseAttentionLeader("alpha");
		assert.equal(broker.claimAttentionLeader("beta", 222), true);
	});
});
