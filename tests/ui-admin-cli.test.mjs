import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { persistSessionRouting } = await import("../dist/session-routing-store.js");

function withIsolatedStore(fn) {
	return async () => {
		const previousLocalAppData = process.env.LOCALAPPDATA;
		const previousAppData = process.env.APPDATA;
		const root = mkdtempSync(join(tmpdir(), "pi-speak-ui-cli-"));
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

test("pi-speak-admin --help prints the real Ink CLI usage", async () => {
	const { stdout, stderr } = await execFileAsync(process.execPath, ["dist/ui/admin.js", "--help"], {
		cwd: process.cwd(),
	});

	assert.equal(stderr, "");
	assert.match(stdout, /pi-speak-admin - management pane/i);
	assert.match(stdout, /--snapshot/);
	assert.match(stdout, /--current-path/);
	assert.match(stdout, /--current-name/);
	assert.doesNotMatch(stdout, /stub/i);
});

test("pi-speak-admin --snapshot renders the pane chrome with compact routes and focused footer", withIsolatedStore(async () => {
	persistSessionRouting({
		sessions: {
			Voice: "/sessions/voice.jsonl",
			"voice-bugfix": "/sessions/bugfix.jsonl",
		},
		aliases: {
			one: "/sessions/voice.jsonl",
			two: "/sessions/bugfix.jsonl",
		},
	});

	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		[
			"dist/ui/admin.js",
			"--snapshot",
			"--current-path",
			"/sessions/bugfix.jsonl",
			"--current-name",
			"voice-bugfix",
		],
		{
			cwd: process.cwd(),
			env: { ...process.env },
		},
	);

	assert.equal(stderr, "");
	assert.match(stdout, /pi-speak session manager/i);
	assert.match(stdout, /Compact routes/i);
	assert.match(stdout, /1: Voice via one/i);
	assert.match(stdout, /2: voice-bugfix via two/i);
	assert.match(stdout, /Focused session/i);
	assert.match(stdout, /voice-bugfix/i);
	assert.match(stdout, /compact: PK2 via two/i);
	assert.match(stdout, /\[↑↓\/tab\/jk\] move/i);
}));
