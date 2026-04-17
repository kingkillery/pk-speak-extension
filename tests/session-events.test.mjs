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

		const tail = tailSessionEvents(0);
		assert.equal(tail.events.length, 200);
		assert.equal(tail.nextOffset, 200);
	}),
);

test(
	"tailSessionEvents resets when offset exceeds current line count",
	withIsolatedStore(async () => {
		appendSessionEvent("a", "voice", {});
		appendSessionEvent("b", "voice", {});

		const tail = tailSessionEvents(999);
		assert.equal(tail.events.length, 2);
		assert.equal(tail.events[0].kind, "a");
		assert.equal(tail.nextOffset, 2);
	}),
);
