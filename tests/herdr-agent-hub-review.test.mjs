import test from "node:test";
import assert from "node:assert/strict";
import { buildHubReviewPrompt } from "../dist/herdr-agent-hub-review.js";

const lanes = [
	{ id: "zeta-lane", kind: "background", status: "running", cwd: "C:\\dev\\zeta", sessionFile: "C:\\sessions\\zeta.jsonl" },
	{ id: "alpha-lane", kind: "background", status: "idle", cwd: "C:\\dev\\alpha", sessionFile: "C:\\sessions\\alpha.jsonl" },
	{ id: "no-transcript", kind: "sub", status: "parked", cwd: null, sessionFile: null },
];

test("prompt leads with a single-line Hub review title for lane discovery", () => {
	const prompt = buildHubReviewPrompt({ question: "why did the\nrefactor lane   fail?", lanes });
	const firstLine = prompt.split("\n")[0];
	assert.equal(firstLine, "Hub review: why did the refactor lane fail?", "title is flattened to one line");
});

test("prompt carries the question, sorted inventory with transcript paths, and rules", () => {
	const prompt = buildHubReviewPrompt({ question: "what broke?", lanes });
	assert.match(prompt, /REVIEW QUESTION\nwhat broke\?/);
	// Sorted by id, each with kind/status/cwd/transcript.
	const alphaIdx = prompt.indexOf("- alpha-lane | background | idle | C:\\dev\\alpha | C:\\sessions\\alpha.jsonl");
	const zetaIdx = prompt.indexOf("- zeta-lane | background | running | C:\\dev\\zeta | C:\\sessions\\zeta.jsonl");
	assert.ok(alphaIdx > 0 && zetaIdx > alphaIdx, "inventory sorted by id with full details");
	assert.match(prompt, /- no-transcript \| sub \| parked \| unknown cwd \| no transcript/);
	// The bounded-read rule and read-only boundary are load-bearing.
	assert.match(prompt, /NEVER read a whole transcript file/);
	assert.match(prompt, /strictly read-only/);
	assert.match(prompt, /VERDICT:/);
	assert.match(prompt, /EVIDENCE:/);
	assert.match(prompt, /CAVEATS:/);
});

test("lane inventory is capped and overflow is counted", () => {
	const many = Array.from({ length: 40 }, (_, i) => ({
		id: `lane-${String(i).padStart(2, "0")}`, kind: "background", status: "idle", cwd: null, sessionFile: null,
	}));
	const prompt = buildHubReviewPrompt({ question: "q", lanes: many, maxLanes: 10 });
	assert.equal((prompt.match(/^- lane-/gm) ?? []).length, 10);
	assert.match(prompt, /and 30 more lanes omitted/);
});

test("empty hub produces an explicit empty inventory, not a blank section", () => {
	const prompt = buildHubReviewPrompt({ question: "q", lanes: [] });
	assert.match(prompt, /hub is empty — no lanes to inspect/);
});
