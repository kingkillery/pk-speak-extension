import test from "node:test";
import assert from "node:assert/strict";

const { parseHerdrAgentListPayload } = await import("../dist/herdr-client.js");

const agent = {
	terminal_id: "term-1",
	agent_status: "idle",
	workspace_id: "ws-1",
	tab_id: "tab-1",
	pane_id: "ws-1:tab-1:p1",
	focused: false,
	revision: 12,
};

test("Herdr agent list parser accepts nested socket responses", () => {
	const parsed = parseHerdrAgentListPayload({
		id: "cli:agent:list",
		result: { type: "agent_list", agents: [agent] },
	});
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].pane_id, agent.pane_id);
});

test("Herdr agent list parser accepts top-level CLI payloads", () => {
	const parsed = parseHerdrAgentListPayload({ agents: [agent] });
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].terminal_id, agent.terminal_id);
});

test("Herdr agent list parser accepts items-shaped CLI payloads", () => {
	const parsed = parseHerdrAgentListPayload({ result: { items: [agent] } });
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].terminal_id, agent.terminal_id);
});
