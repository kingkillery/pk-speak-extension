import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { getPlayerInvocation, playAudio } = await import("../dist/audio-playback.js");

function referencesPath(invocation, filePath) {
	// On win32 the path is backslash-escaped inside the PowerShell block, so the
	// raw filePath may not appear verbatim. Normalize both sides before checking.
	const joined = invocation.args.join("\n");
	if (joined.includes(filePath)) return true;
	const escaped = filePath.replace(/\\/g, "\\\\");
	if (joined.includes(escaped)) return true;
	// Last resort: compare with all backslashes collapsed to forward slashes.
	const normalizedJoined = joined.replace(/\\\\/g, "\\").replace(/\\/g, "/");
	const normalizedPath = filePath.replace(/\\/g, "/");
	return normalizedJoined.includes(normalizedPath);
}

test("getPlayerInvocation returns a command and args array referencing the path", () => {
	const filePath = join(tmpdir(), "pk-speak-playback-sample.mp3");
	const invocation = getPlayerInvocation(filePath);

	assert.equal(typeof invocation, "object");
	assert.notEqual(invocation, null);
	assert.equal(typeof invocation.command, "string");
	assert.notEqual(invocation.command.trim(), "");
	assert.ok(Array.isArray(invocation.args), "args should be an array");
	assert.ok(
		referencesPath(invocation, filePath),
		`expected args to reference ${filePath}, got ${JSON.stringify(invocation.args)}`,
	);
});

test("getPlayerInvocation uses powershell.exe on win32", () => {
	const filePath = join(tmpdir(), "pk-speak-playback-win.mp3");
	const invocation = getPlayerInvocation(filePath);

	if (process.platform === "win32") {
		assert.equal(invocation.command, "powershell.exe");
		// The Windows MediaPlayer block backslash-escapes the path; verify the
		// escaped form is present in the command body.
		const escaped = filePath.replace(/\\/g, "\\\\");
		assert.ok(
			invocation.args.some((arg) => arg.includes(escaped)),
			"expected the PowerShell block to contain the backslash-escaped path",
		);
	} else if (process.platform === "darwin") {
		assert.equal(invocation.command, "afplay");
		assert.deepEqual(invocation.args, [filePath]);
	} else {
		// linux/other defaults to ffplay per the contract.
		assert.equal(invocation.command, "ffplay");
		assert.ok(invocation.args.includes(filePath));
		assert.ok(invocation.args.includes("-nodisp"));
		assert.ok(invocation.args.includes("-autoexit"));
	}
});

test("getPlayerInvocation returns the same shape for distinct paths", () => {
	const a = getPlayerInvocation(join(tmpdir(), "pk-a.mp3"));
	const b = getPlayerInvocation(join(tmpdir(), "pk-b.mp3"));
	assert.equal(a.command, b.command);
	assert.equal(Array.isArray(a.args), true);
	assert.equal(Array.isArray(b.args), true);
});

test("playAudio is an exported function (no real audio played here)", () => {
	assert.equal(typeof playAudio, "function");
});
