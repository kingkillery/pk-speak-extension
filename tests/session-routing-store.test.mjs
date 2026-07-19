import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	getSessionRoutingStorePath,
	loadPersistedSessionRouting,
	persistSessionRouting,
} from "../dist/session-routing-store.js";

test("session routing persists across reloads", async () => {
	const previousLocalAppData = process.env.LOCALAPPDATA;
	const previousAppData = process.env.APPDATA;
	const root = mkdtempSync(join(tmpdir(), "pi-speak-routing-"));
	process.env.LOCALAPPDATA = root;
	process.env.APPDATA = root;

	try {
		persistSessionRouting({
			sessions: {
				Bugfix: "/sessions/bugfix.jsonl",
			},
			aliases: {
				One: "/sessions/bugfix.jsonl",
			},
		});

		const loaded = loadPersistedSessionRouting();
		assert.deepEqual(loaded, {
			version: 1,
			updatedAt: loaded.updatedAt,
			sessions: {
				Bugfix: "/sessions/bugfix.jsonl",
			},
			aliases: {
				One: "/sessions/bugfix.jsonl",
			},
			archivedPaths: [],
		});
		assert.ok(loaded.updatedAt > 0);
	} finally {
		if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = previousLocalAppData;
		if (previousAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = previousAppData;
		rmSync(root, { recursive: true, force: true });
	}
});

test("session routing loader ignores malformed records", async () => {
	const previousLocalAppData = process.env.LOCALAPPDATA;
	const previousAppData = process.env.APPDATA;
	const root = mkdtempSync(join(tmpdir(), "pi-speak-routing-"));
	process.env.LOCALAPPDATA = root;
	process.env.APPDATA = root;

	try {
		const path = getSessionRoutingStorePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({
			updatedAt: "oops",
			sessions: {
				Good: "/sessions/good.jsonl",
				Bad: 42,
			},
			aliases: "not-an-object",
		}), "utf8");

		assert.deepEqual(loadPersistedSessionRouting(), {
			version: 1,
			updatedAt: 0,
			sessions: {
				Good: "/sessions/good.jsonl",
			},
			aliases: {},
			archivedPaths: [],
		});
	} finally {
		if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = previousLocalAppData;
		if (previousAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = previousAppData;
		rmSync(root, { recursive: true, force: true });
	}
});
