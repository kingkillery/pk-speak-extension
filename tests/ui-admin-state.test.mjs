import test from "node:test";
import assert from "node:assert/strict";

const {
	parseAdminCliArgs,
	buildPaneCompactRouteSlots,
	describeFocusedSessionSlots,
	ensureFocusedPath,
	moveFocusedPath,
	findFocusedEntry,
} = await import("../dist/ui/admin-state.js");

function makeDashboard() {
	return {
		current: "voice",
		ready: ["voice-bugfix"],
		storePath: "/tmp/session-routing.json",
		sessions: [
			{
				name: "voice",
				path: "/sessions/voice.jsonl",
				current: true,
				isCurrent: true,
				ready: false,
				isReady: false,
				activity: "idle",
				aliases: ["one"],
			},
			{
				name: "voice-bugfix",
				path: "/sessions/bugfix.jsonl",
				current: false,
				isCurrent: false,
				ready: true,
				isReady: true,
				activity: "busy",
				aliases: ["two"],
			},
			{
				name: "saved-only",
				path: "/sessions/saved.jsonl",
				current: false,
				isCurrent: false,
				ready: false,
				isReady: false,
				activity: "saved",
				aliases: [],
			},
		],
	};
}

test("parseAdminCliArgs reads help and launch context flags", () => {
	const parsed = parseAdminCliArgs([
		"node",
		"admin.js",
		"--current-path",
		"/sessions/bugfix.jsonl",
		"--current-name",
		"voice bugfix",
		"--snapshot",
		"--help",
	]);

	assert.equal(parsed.showHelp, true);
	assert.equal(parsed.showSnapshot, true);
	assert.equal(parsed.currentSessionPath, "/sessions/bugfix.jsonl");
	assert.equal(parsed.currentSessionName, "voice bugfix");
});

test("ensureFocusedPath prefers the current session when no focus exists", () => {
	const dashboard = makeDashboard();
	assert.equal(ensureFocusedPath(dashboard, undefined), "/sessions/voice.jsonl");
});

test("ensureFocusedPath falls back when the previous focus disappears", () => {
	const dashboard = makeDashboard();
	assert.equal(ensureFocusedPath(dashboard, "/sessions/missing.jsonl"), "/sessions/voice.jsonl");
});

test("moveFocusedPath cycles through focusable session rows", () => {
	const dashboard = makeDashboard();
	assert.equal(moveFocusedPath(dashboard, "/sessions/voice.jsonl", 1), "/sessions/bugfix.jsonl");
	assert.equal(moveFocusedPath(dashboard, "/sessions/voice.jsonl", -1), "/sessions/saved.jsonl");
});

test("findFocusedEntry resolves the focused row metadata", () => {
	const dashboard = makeDashboard();
	const entry = findFocusedEntry(dashboard, "/sessions/bugfix.jsonl");
	assert.equal(entry?.name, "voice-bugfix");
	assert.deepEqual(entry?.aliases, ["two"]);
});

test("compact route helpers map the focused session to PK families", () => {
	const dashboard = makeDashboard();
	const focused = findFocusedEntry(dashboard, "/sessions/bugfix.jsonl");
	const slots = buildPaneCompactRouteSlots(dashboard);
	assert.equal(slots.length, 2);
	assert.equal(slots[0].sessionName, "voice");
	assert.equal(slots[1].sessionName, "voice-bugfix");
	assert.deepEqual(describeFocusedSessionSlots(focused, slots), ["PK2 via two"]);
});
