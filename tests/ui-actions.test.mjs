import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	addWakeAlias,
	beginRemoveSession,
	confirmRemoveSession,
	removeWakeAlias,
	renameSession,
	REMOVE_CONFIRM_TTL_MS,
} from "../dist/ui/actions.js";
import {
	loadPersistedSessionRouting,
	persistSessionRouting,
} from "../dist/session-routing-store.js";
import { tailSessionEvents } from "../dist/session-events.js";

function withIsolatedStore(fn) {
	return async () => {
		const previousLocalAppData = process.env.LOCALAPPDATA;
		const previousAppData = process.env.APPDATA;
		const root = mkdtempSync(join(tmpdir(), "pi-speak-ui-actions-"));
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
	"renameSession persists new name and emits admin sess.rename event",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Bugfix: "/sessions/bugfix.jsonl" },
			aliases: { two: "/sessions/bugfix.jsonl" },
		});

		const result = renameSession({
			sessionPath: "/sessions/bugfix.jsonl",
			newName: "Feature",
		});
		assert.equal(result.ok, true);
		assert.equal(result.from, "Bugfix");
		assert.equal(result.to, "Feature");

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.sessions, { Feature: "/sessions/bugfix.jsonl" });
		assert.deepEqual(persisted.aliases, { two: "/sessions/bugfix.jsonl" });

		const { events } = tailSessionEvents(0);
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "sess.rename");
		assert.equal(events[0].source, "admin");
		assert.equal(events[0].payload.from, "Bugfix");
		assert.equal(events[0].payload.to, "Feature");
		assert.equal(events[0].payload.path, "/sessions/bugfix.jsonl");
	}),
);

test(
	"renameSession rejects duplicate name pointing at another session and emits no event",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: {
				Bugfix: "/sessions/bugfix.jsonl",
				Docs: "/sessions/docs.jsonl",
			},
			aliases: {},
		});

		const result = renameSession({
			sessionPath: "/sessions/bugfix.jsonl",
			newName: "Docs",
		});
		assert.equal(result.ok, false);
		assert.match(result.error, /already points/i);

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.sessions, {
			Bugfix: "/sessions/bugfix.jsonl",
			Docs: "/sessions/docs.jsonl",
		});

		const { events } = tailSessionEvents(0);
		assert.equal(events.length, 0, "no event emitted on rejected rename");
	}),
);

test(
	"addWakeAlias normalizes whitespace and emits admin alias.add event",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Docs: "/sessions/docs.jsonl" },
			aliases: {},
		});

		const result = addWakeAlias({
			sessionPath: "/sessions/docs.jsonl",
			alias: "   notes    pane   ",
		});
		assert.equal(result.ok, true);
		assert.equal(result.alias, "notes pane");
		assert.equal(result.sessionName, "Docs");

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.aliases, { "notes pane": "/sessions/docs.jsonl" });

		const { events } = tailSessionEvents(0);
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "alias.add");
		assert.equal(events[0].source, "admin");
		assert.equal(events[0].payload.alias, "notes pane");
		assert.equal(events[0].payload.name, "Docs");
		assert.equal(events[0].payload.path, "/sessions/docs.jsonl");
	}),
);

test(
	"addWakeAlias rejects empty alias input",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Docs: "/sessions/docs.jsonl" },
			aliases: {},
		});
		const result = addWakeAlias({ sessionPath: "/sessions/docs.jsonl", alias: "   " });
		assert.equal(result.ok, false);
		assert.match(result.error, /required/i);

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.aliases, {});
		const { events } = tailSessionEvents(0);
		assert.equal(events.length, 0);
	}),
);

test(
	"removeWakeAlias clears an existing alias and emits admin alias.remove",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Docs: "/sessions/docs.jsonl" },
			aliases: { nav: "/sessions/docs.jsonl" },
		});

		const result = removeWakeAlias({ alias: "nav" });
		assert.equal(result.ok, true);
		assert.equal(result.alias, "nav");

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.aliases, {});

		const { events } = tailSessionEvents(0);
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "alias.remove");
		assert.equal(events[0].source, "admin");
		assert.equal(events[0].payload.alias, "nav");
	}),
);

test(
	"remove is two-step: beginRemoveSession + confirmRemoveSession emits admin sess.remove",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: {
				Bugfix: "/sessions/bugfix.jsonl",
				Docs: "/sessions/docs.jsonl",
			},
			aliases: {
				two: "/sessions/bugfix.jsonl",
				notes: "/sessions/bugfix.jsonl",
				three: "/sessions/docs.jsonl",
			},
		});

		const pending = beginRemoveSession({
			sessionPath: "/sessions/bugfix.jsonl",
			nowMs: 1_000,
		});
		assert.equal(pending.ok, true);
		assert.equal(pending.sessionName, "Bugfix");
		assert.equal(pending.sessionPath, "/sessions/bugfix.jsonl");
		assert.equal(pending.requestedAt, 1_000);

		const offsetAfterBegin = tailSessionEvents(0).nextOffset;
		assert.equal(offsetAfterBegin, 0, "begin emits no event on its own");

		const midPersisted = loadPersistedSessionRouting();
		assert.deepEqual(midPersisted.sessions, {
			Bugfix: "/sessions/bugfix.jsonl",
			Docs: "/sessions/docs.jsonl",
		}, "store untouched before confirm");

		const confirm = confirmRemoveSession({
			pending,
			sessionPath: "/sessions/bugfix.jsonl",
			nowMs: 2_000,
		});
		assert.equal(confirm.ok, true);
		assert.equal(confirm.sessionName, "Bugfix");
		assert.deepEqual(confirm.removedNames, ["Bugfix"]);
		assert.deepEqual(confirm.removedAliases.sort(), ["notes", "two"]);

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.sessions, { Docs: "/sessions/docs.jsonl" });
		assert.deepEqual(persisted.aliases, { three: "/sessions/docs.jsonl" });

		const { events } = tailSessionEvents(0);
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "sess.remove");
		assert.equal(events[0].source, "admin");
		assert.equal(events[0].payload.name, "Bugfix");
		assert.equal(events[0].payload.path, "/sessions/bugfix.jsonl");
		assert.ok(Array.isArray(events[0].payload.removedAliases));
	}),
);

test(
	"confirmRemoveSession rejects without a pending request",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Bugfix: "/sessions/bugfix.jsonl" },
			aliases: {},
		});
		const result = confirmRemoveSession({
			pending: undefined,
			sessionPath: "/sessions/bugfix.jsonl",
			nowMs: 1_000,
		});
		assert.equal(result.ok, false);
		assert.match(result.error, /no pending removal/i);

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.sessions, { Bugfix: "/sessions/bugfix.jsonl" });
	}),
);

test(
	"confirmRemoveSession rejects when pending is for a different session",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: {
				Bugfix: "/sessions/bugfix.jsonl",
				Docs: "/sessions/docs.jsonl",
			},
			aliases: {},
		});
		const pending = beginRemoveSession({
			sessionPath: "/sessions/bugfix.jsonl",
			nowMs: 1_000,
		});
		assert.equal(pending.ok, true);

		const result = confirmRemoveSession({
			pending,
			sessionPath: "/sessions/docs.jsonl",
			nowMs: 2_000,
		});
		assert.equal(result.ok, false);
		assert.match(result.error, /different session/i);

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.sessions, {
			Bugfix: "/sessions/bugfix.jsonl",
			Docs: "/sessions/docs.jsonl",
		});
	}),
);

test(
	"confirmRemoveSession expires after TTL",
	withIsolatedStore(async () => {
		persistSessionRouting({
			sessions: { Bugfix: "/sessions/bugfix.jsonl" },
			aliases: {},
		});
		const pending = beginRemoveSession({
			sessionPath: "/sessions/bugfix.jsonl",
			nowMs: 1_000,
		});
		assert.equal(pending.ok, true);

		const result = confirmRemoveSession({
			pending,
			sessionPath: "/sessions/bugfix.jsonl",
			nowMs: 1_000 + REMOVE_CONFIRM_TTL_MS + 1,
		});
		assert.equal(result.ok, false);
		assert.match(result.error, /expired/i);

		const persisted = loadPersistedSessionRouting();
		assert.deepEqual(persisted.sessions, { Bugfix: "/sessions/bugfix.jsonl" });
	}),
);
