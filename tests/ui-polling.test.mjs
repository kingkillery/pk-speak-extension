import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_TOAST_TTL_MS,
	eventToToast,
	filterActiveToasts,
	formatEventMessage,
	getRoutingStoreMtime,
	pollTick,
	toastsFromEvents,
} from "../dist/ui/hooks/useSessionStore.js";
import {
	appendSessionEvent,
	tailSessionEvents,
} from "../dist/session-events.js";
import {
	getSessionRoutingStorePath,
	persistSessionRouting,
} from "../dist/session-routing-store.js";

function withIsolatedStore(fn) {
	return async () => {
		const previousLocalAppData = process.env.LOCALAPPDATA;
		const previousAppData = process.env.APPDATA;
		const root = mkdtempSync(join(tmpdir(), "pi-speak-ui-polling-"));
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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("defaults match spec: 500ms poll interval, 3s toast TTL", () => {
	assert.equal(DEFAULT_POLL_INTERVAL_MS, 500);
	assert.equal(DEFAULT_TOAST_TTL_MS, 3000);
});

test(
	"pollTick detects external store mutation within one poll interval",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Bugfix: "/sessions/bugfix.jsonl" },
			aliases: {},
		});

		const initialMtime = getRoutingStoreMtime();
		assert.ok(initialMtime > 0, "initial mtime should be non-zero after persist");

		const first = pollTick({
			previousStoreMtime: initialMtime,
			previousEventOffset: 0,
			previousToasts: [],
			dashboardOptions: { runtimeSnapshots: [] },
			now: Date.now(),
			toastTtlMs: DEFAULT_TOAST_TTL_MS,
		});
		assert.equal(first.storeMtime, initialMtime);
		assert.equal(first.dashboard, undefined, "no reload when mtime unchanged");

		await sleep(DEFAULT_POLL_INTERVAL_MS + 50);
		persistSessionRouting({
			sessions: {
				Bugfix: "/sessions/bugfix.jsonl",
				Docs: "/sessions/docs.jsonl",
			},
			aliases: { two: "/sessions/docs.jsonl" },
		});

		const updatedMtime = getRoutingStoreMtime();
		assert.notEqual(updatedMtime, initialMtime, "mtime must advance after persist");

		const second = pollTick({
			previousStoreMtime: initialMtime,
			previousEventOffset: 0,
			previousToasts: [],
			dashboardOptions: { runtimeSnapshots: [] },
			now: Date.now(),
			toastTtlMs: DEFAULT_TOAST_TTL_MS,
		});
		assert.equal(second.storeMtime, updatedMtime);
		assert.ok(second.dashboard, "dashboard reloaded on mtime change");
		assert.equal(second.dashboard.storePath, getSessionRoutingStorePath());
		assert.equal(second.dashboard.sessions.length, 2, "both sessions visible after reload");
	}),
);

test(
	"pollTick tails only new events since previous offset",
	withIsolatedStore(async () => {
		persistSessionRouting({ sessions: {}, aliases: {} });
		appendSessionEvent("sess.rename", "voice", { from: "One", to: "Two" });
		appendSessionEvent("alias.add", "admin", { alias: "nav", session: "Docs" });

		const firstOffset = tailSessionEvents(0).nextOffset;
		assert.equal(firstOffset, 2);

		const idle = pollTick({
			previousStoreMtime: getRoutingStoreMtime(),
			previousEventOffset: firstOffset,
			previousToasts: [],
			dashboardOptions: { runtimeSnapshots: [] },
			now: 10_000,
			toastTtlMs: DEFAULT_TOAST_TTL_MS,
		});
		assert.deepEqual(idle.newEvents, [], "no new events after catching up");
		assert.equal(idle.toasts.length, 0);
		assert.equal(idle.eventOffset, 2);

		appendSessionEvent("sess.new", "voice", { name: "Research" });

		const delta = pollTick({
			previousStoreMtime: getRoutingStoreMtime(),
			previousEventOffset: idle.eventOffset,
			previousToasts: [],
			dashboardOptions: { runtimeSnapshots: [] },
			now: 20_000,
			toastTtlMs: DEFAULT_TOAST_TTL_MS,
		});
		assert.equal(delta.newEvents.length, 1, "only the single new event returned");
		assert.equal(delta.newEvents[0].kind, "sess.new");
		assert.equal(delta.newEvents[0].source, "voice");
		assert.equal(delta.eventOffset, 3);
		assert.equal(delta.toasts.length, 1, "voice event produces toast");
		assert.equal(delta.toasts[0].source, "voice");
		assert.match(delta.toasts[0].message, /Research/);
	}),
);

test(
	"toast TTL expires after ttlMs elapses",
	withIsolatedStore(async () => {
		const baseNow = 1_000_000;
		const voiceEvent = {
			ts: baseNow,
			kind: "sess.rename",
			source: "voice",
			payload: { from: "Docs", to: "Notes" },
		};
		const adminEvent = {
			ts: baseNow,
			kind: "alias.add",
			source: "admin",
			payload: { alias: "nav", session: "Notes" },
		};
		const commandEvent = {
			ts: baseNow,
			kind: "sess.switch",
			source: "command",
			payload: { session: "Typed" },
		};

		const toasts = toastsFromEvents([voiceEvent, adminEvent, commandEvent], baseNow, 3000);
		assert.equal(toasts.length, 2, "command-sourced events do not produce toasts");
		assert.equal(toasts[0].source, "voice");
		assert.equal(toasts[0].expiresAt, baseNow + 3000);
		assert.match(toasts[0].message, /Docs/);
		assert.match(toasts[0].message, /Notes/);
		assert.equal(toasts[1].source, "admin");
		assert.match(toasts[1].message, /nav/);

		const stillActive = filterActiveToasts(toasts, baseNow + 2999);
		assert.equal(stillActive.length, 2, "toasts still visible 1ms before TTL");

		const expired = filterActiveToasts(toasts, baseNow + 3001);
		assert.equal(expired.length, 0, "toasts expire strictly after TTL");

		const atBoundary = filterActiveToasts(toasts, baseNow + 3000);
		assert.equal(atBoundary.length, 0, "expiresAt is exclusive (expires AT ttl)");
	}),
);

test(
	"pollTick merges surviving toasts with new ones and drops expired",
	withIsolatedStore(async () => {
		persistSessionRouting({ sessions: {}, aliases: {} });

		const existingToast = eventToToast(
			{ ts: 0, kind: "sess.rename", source: "voice", payload: { to: "Old" } },
			1_000_000,
			3000,
		);
		const almostExpired = eventToToast(
			{ ts: 0, kind: "sess.new", source: "admin", payload: { name: "Stale" } },
			995_000,
			3000,
		);

		appendSessionEvent("sess.new", "voice", { name: "Fresh" });

		const now = 1_000_500;
		const tick = pollTick({
			previousStoreMtime: getRoutingStoreMtime(),
			previousEventOffset: 0,
			previousToasts: [existingToast, almostExpired],
			dashboardOptions: { runtimeSnapshots: [] },
			now,
			toastTtlMs: 3000,
		});

		assert.equal(tick.toasts.length, 2, "expired toast dropped, new toast merged");
		assert.ok(tick.toasts.some((t) => t.message.includes("Old")), "unexpired surviving toast retained");
		assert.ok(tick.toasts.some((t) => t.message.includes("Fresh")), "new toast from tailed event added");
		assert.ok(!tick.toasts.some((t) => t.message.includes("Stale")), "expired toast removed");
	}),
);

test("formatEventMessage renders spec kinds", () => {
	assert.equal(
		formatEventMessage({ ts: 0, kind: "sess.rename", source: "voice", payload: { from: "A", to: "B" } }),
		"rename A -> B",
	);
	assert.equal(
		formatEventMessage({ ts: 0, kind: "sess.switch", source: "voice", payload: { session: "Docs" } }),
		"switch to Docs",
	);
	assert.equal(
		formatEventMessage({ ts: 0, kind: "alias.add", source: "admin", payload: { alias: "one", session: "Docs" } }),
		"alias one -> Docs",
	);
	assert.equal(
		formatEventMessage({ ts: 0, kind: "alias.remove", source: "admin", payload: { alias: "one" } }),
		"alias clear one",
	);
});
