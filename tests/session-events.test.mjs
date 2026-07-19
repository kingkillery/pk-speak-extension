import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	appendSessionEvent,
	getSessionEventsPath,
	tailSessionEvents,
} from "../dist/session-events.js";

function withIsolatedStore(fn) {
	return async () => {
		const previousLocalAppData = process.env.LOCALAPPDATA;
		const previousAppData = process.env.APPDATA;
		const root = mkdtempSync(join(tmpdir(), "pi-speak-events-"));
		process.env.LOCALAPPDATA = root;
		process.env.APPDATA = root;
		try {
			await fn(root);
		} finally {
			if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = previousLocalAppData;
			if (previousAppData === undefined) delete process.env.APPDATA;
			else process.env.APPDATA = previousAppData;
			rmSync(root, { recursive: true, force: true });
		}
	};
}

test(
	"appendSessionEvent writes JSON lines with ts/kind/source/payload",
	withIsolatedStore(async () => {
		const before = Date.now();
		appendSessionEvent("wake-set", "voice", { alias: "one", session: "bugfix" });
		appendSessionEvent("rename", "admin", { from: "one", to: "active-work" });
		const after = Date.now();

		const path = getSessionEventsPath();
		assert.ok(existsSync(path), "event log file should exist after append");
		const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
		assert.equal(lines.length, 2);

		const first = JSON.parse(lines[0]);
		assert.equal(first.kind, "wake-set");
		assert.equal(first.source, "voice");
		assert.deepEqual(first.payload, { alias: "one", session: "bugfix" });
		assert.equal(typeof first.ts, "number");
		assert.ok(first.ts >= before && first.ts <= after);

		const second = JSON.parse(lines[1]);
		assert.equal(second.kind, "rename");
		assert.equal(second.source, "admin");
		assert.deepEqual(second.payload, { from: "one", to: "active-work" });
	}),
);

test(
	"tailSessionEvents returns only new events since offset",
	withIsolatedStore(async () => {
		const empty = tailSessionEvents();
		assert.deepEqual(empty, { events: [], nextOffset: 0 });

		appendSessionEvent("switch", "voice", { session: "docs" });
		appendSessionEvent("alias-set", "command", { alias: "two", session: "docs" });

		const firstTail = tailSessionEvents(empty.nextOffset);
		assert.equal(firstTail.events.length, 2);
		assert.equal(firstTail.events[0].kind, "switch");
		assert.equal(firstTail.events[0].source, "voice");
		assert.deepEqual(firstTail.events[0].payload, { session: "docs" });
		assert.equal(firstTail.events[1].kind, "alias-set");
		assert.equal(firstTail.nextOffset, 2);

		const idle = tailSessionEvents(firstTail.nextOffset);
		assert.deepEqual(idle, { events: [], nextOffset: 2 });

		appendSessionEvent("remove", "admin", { session: "docs" });
		const thirdTail = tailSessionEvents(firstTail.nextOffset);
		assert.equal(thirdTail.events.length, 1);
		assert.equal(thirdTail.events[0].kind, "remove");
		assert.equal(thirdTail.events[0].source, "admin");
		assert.equal(thirdTail.nextOffset, 3);
	}),
);

test(
	"appendSessionEvent rotates at the 200-line boundary",
	withIsolatedStore(async () => {
		for (let i = 0; i < 205; i++) {
			appendSessionEvent("tick", "command", { i });
		}

		const path = getSessionEventsPath();
		const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
		assert.equal(lines.length, 200, "log must be bounded to last 200 lines");

		const firstRetained = JSON.parse(lines[0]);
		const lastRetained = JSON.parse(lines[lines.length - 1]);
		assert.equal(firstRetained.payload.i, 5, "oldest entries rotated off");
		assert.equal(lastRetained.payload.i, 204, "newest entry retained");

		// Cursor is now the high-water seq (trim-stable), not the line count: 205
		// events were appended, so the newest seq is 205 even though only 200 lines
		// are retained.
		const tail = tailSessionEvents(0);
		assert.equal(tail.events.length, 200);
		assert.equal(tail.nextOffset, 205);
	}),
);

test(
	"tailSessionEvents treats the cursor as a seen-seq, not a line index",
	withIsolatedStore(async () => {
		appendSessionEvent("a", "voice", {});
		appendSessionEvent("b", "voice", {});

		// A cursor ahead of every existing seq means "I've already seen everything":
		// return nothing, and report the true high-water seq (not replay history as
		// the old line-index implementation did).
		const tail = tailSessionEvents(999);
		assert.equal(tail.events.length, 0);
		assert.equal(tail.nextOffset, 999);
	}),
);

test(
	"tailSessionEvents keeps delivering new events across the 200-line rollover",
	withIsolatedStore(async () => {
		// Fill to the cap, take the cursor, then append past the rollover.
		for (let i = 0; i < 200; i++) appendSessionEvent("tick", "command", { i });
		const atCap = tailSessionEvents(0);
		assert.equal(atCap.events.length, 200);
		assert.equal(atCap.nextOffset, 200);

		// Idle poll: nothing new.
		assert.deepEqual(tailSessionEvents(atCap.nextOffset).events, []);

		// Append 5 more — the log trims, line indices shift, but the seq cursor must
		// still surface exactly these 5 (the original line-index bug returned none).
		for (let i = 200; i < 205; i++) appendSessionEvent("tick", "command", { i });
		const afterRollover = tailSessionEvents(atCap.nextOffset);
		assert.equal(afterRollover.events.length, 5, "must deliver the 5 post-rollover events");
		assert.deepEqual(afterRollover.events.map((e) => e.payload.i), [200, 201, 202, 203, 204]);
		assert.equal(afterRollover.nextOffset, 205);
	}),
);
