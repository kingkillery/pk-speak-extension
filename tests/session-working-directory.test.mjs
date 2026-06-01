import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { buildSessionWorkingDirectoryMap, readSessionWorkingDirectory } = await import("../dist/session-working-directory.js");

test("readSessionWorkingDirectory reads Codex session_meta cwd", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-speak-session-cwd-"));
	try {
		const sessionPath = join(dir, "rollout.jsonl");
		writeFileSync(sessionPath, `${JSON.stringify({
			type: "session_meta",
			payload: { cwd: "C:\\dev\\Desktop-Projects\\pi-speak-extension" },
		})}\n`);
		assert.equal(readSessionWorkingDirectory(sessionPath), "C:\\dev\\Desktop-Projects\\pi-speak-extension");
		assert.deepEqual(buildSessionWorkingDirectoryMap([sessionPath]), {
			[sessionPath]: "C:\\dev\\Desktop-Projects\\pi-speak-extension",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildSessionWorkingDirectoryMap prefers explicit fallbacks", () => {
	assert.deepEqual(buildSessionWorkingDirectoryMap(["/missing/session.jsonl"], {
		"/missing/session.jsonl": "/workspace/current",
	}), {
		"/missing/session.jsonl": "/workspace/current",
	});
});
