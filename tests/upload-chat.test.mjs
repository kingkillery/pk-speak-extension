import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseUploadChatArgs, resolveSyncHost, resolveSyncScript, summarizeSyncOutput } from "../dist/upload-chat.js";

test("parseUploadChatArgs defaults to push so 'upload' never lies about direction", () => {
	const bare = parseUploadChatArgs("mac2");
	assert.equal(bare.ok, true);
	assert.deepEqual(bare.args, { action: "push", host: "mac2" });

	const pull = parseUploadChatArgs("pull mac2");
	assert.equal(pull.args.action, "pull");
	assert.equal(pull.args.host, "mac2");

	const status = parseUploadChatArgs("status k@100.109.244.1 --cwd C:/dev/fork");
	assert.equal(status.args.action, "status");
	assert.equal(status.args.host, "k@100.109.244.1");
	assert.equal(status.args.cwd, "C:/dev/fork");
});

test("parseUploadChatArgs rejects missing host and extra positionals", () => {
	assert.equal(parseUploadChatArgs("").ok, false);
	assert.equal(parseUploadChatArgs("push").ok, false);
	const extra = parseUploadChatArgs("push mac2 mac");
	assert.equal(extra.ok, false);
	assert.match(extra.error, /extra arguments/i);
});

test("resolveSyncHost maps PI_SPEAK_SYNC_HOSTS aliases and passes raw targets through", () => {
	const env = { PI_SPEAK_SYNC_HOSTS: "mac2=k@100.109.244.1; mac=k@100.76.176.119" };
	assert.equal(resolveSyncHost("mac2", env), "k@100.109.244.1");
	assert.equal(resolveSyncHost("MAC", env), "k@100.76.176.119");
	assert.equal(resolveSyncHost("pk@100.111.69.99", env), "pk@100.111.69.99");
	assert.equal(resolveSyncHost("mac2", {}), "mac2");
});

test("resolveSyncScript walks up to the repo root and stops at .git", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-upload-chat-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "scripts"));
	writeFileSync(join(root, "scripts", "codespace-sync.ts"), "// stub");
	mkdirSync(join(root, "src", "deep"), { recursive: true });

	const fromDeep = resolveSyncScript(join(root, "src", "deep"));
	assert.equal(fromDeep.repoRoot, root);
	assert.equal(fromDeep.script, join(root, "scripts", "codespace-sync.ts"));

	const bare = mkdtempSync(join(tmpdir(), "pi-upload-chat-bare-"));
	mkdirSync(join(bare, ".git"));
	assert.equal(resolveSyncScript(join(bare)), undefined);
});

test("summarizeSyncOutput keeps the last meaningful lines", () => {
	const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n\n   \n";
	const summary = summarizeSyncOutput(output, 5);
	assert.deepEqual(summary.split("\n"), ["line 25", "line 26", "line 27", "line 28", "line 29"]);
});
