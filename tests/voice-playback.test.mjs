import test from "node:test";
import assert from "node:assert/strict";
import { extractDiff, extractErrors, parsePlaybackCommand } from "../dist/voice-playback.js";

test("parsePlaybackCommand recognises repeat phrases", () => {
	for (const phrase of ["repeat", "repeat that", "say that again", "say it again", "read it again", "play it again", "what was that", "what did you say"]) {
		assert.equal(parsePlaybackCommand(phrase), "repeat", `expected "${phrase}" → repeat`);
	}
});

test("parsePlaybackCommand recognises read-error phrases", () => {
	for (const phrase of ["read the error", "read the errors", "what was the error", "read the last error", "read me the errors"]) {
		assert.equal(parsePlaybackCommand(phrase), "read-error", `expected "${phrase}" → read-error`);
	}
});

test("parsePlaybackCommand recognises read-diff phrases", () => {
	for (const phrase of ["read the diff", "read the code", "read the patch", "what was the diff", "read me the patch"]) {
		assert.equal(parsePlaybackCommand(phrase), "read-diff", `expected "${phrase}" → read-diff`);
	}
});

test("parsePlaybackCommand returns undefined for unrelated speech", () => {
	for (const phrase of ["", "deploy the build", "switch to session two", "yes", "what is two plus two"]) {
		assert.equal(parsePlaybackCommand(phrase), undefined);
	}
});

test("extractErrors pulls error lines with leading context", () => {
	const text = [
		"Building project...",
		"src/foo.ts:12:3",
		"  TypeError: cannot read property 'bar' of undefined",
		"   at processInput (src/foo.ts:12:3)",
		"   at main (src/index.ts:8:5)",
		"Build finished with 1 error.",
	].join("\n");
	const result = extractErrors(text);
	assert.match(result, /TypeError: cannot read property 'bar'/);
	assert.match(result, /Build finished with 1 error/);
});

test("extractErrors returns empty string when no error keywords present", () => {
	assert.equal(extractErrors("All tests passed. 42 assertions made."), "");
});

test("extractErrors caps output at maxChars", () => {
	const longLines = Array.from({ length: 200 }, (_, i) => `error ${i}: long message that takes up space here`).join("\n");
	const result = extractErrors(longLines, 400);
	assert.ok(result.length <= 400, `expected length <= 400 but got ${result.length}`);
	assert.match(result, /error 0/);
});

test("extractDiff returns the body of the first triple-backtick block", () => {
	const text = "Here is the change:\n\n```typescript\nconst x = 1;\nconst y = 2;\n```\n\nThat fixes it.";
	const result = extractDiff(text);
	assert.equal(result, "const x = 1;\nconst y = 2;");
});

test("extractDiff handles unfenced unified diffs", () => {
	const text = [
		"Applied this patch:",
		"--- a/foo.ts",
		"+++ b/foo.ts",
		"@@ -1,3 +1,4 @@",
		" const x = 1;",
		"+const y = 2;",
		" const z = 3;",
		"",
		"Run tests now.",
	].join("\n");
	const result = extractDiff(text);
	assert.match(result, /^--- a\/foo\.ts/);
	assert.match(result, /\+const y = 2;/);
});

test("extractDiff returns empty string when no code block is present", () => {
	assert.equal(extractDiff("Just a plain reply with no code or diff."), "");
});

test("extractDiff truncates long blocks with ellipsis", () => {
	const longBody = "x".repeat(2000);
	const text = "```\n" + longBody + "\n```";
	const result = extractDiff(text, 100);
	assert.ok(result.length <= 101, `expected <=101 chars but got ${result.length}`);
	assert.ok(result.endsWith("…"));
});
