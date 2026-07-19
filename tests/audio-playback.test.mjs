import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { buildPlaybackSupervisorArgs, getUnixAudioPlayer, terminateAudioChild } = await import("../dist/audio-playback.js");

test("Unix player selection preserves the established discovery order", () => {
	assert.equal(getUnixAudioPlayer(false, (command) => command === "paplay", "linux"), "paplay");
	assert.equal(getUnixAudioPlayer(false, (command) => command === "mpg123", "linux"), "mpg123");
	assert.equal(getUnixAudioPlayer(false, (command) => command === "ffplay", "linux"), "ffplay");
	assert.equal(getUnixAudioPlayer(false, () => false, "linux"), undefined);
	assert.equal(getUnixAudioPlayer(true, () => false, "linux"), "xdg-open");
	assert.equal(getUnixAudioPlayer(false, () => false, "darwin"), "afplay");
});

test("no-wait playback delegates temp-file cleanup to the detached supervisor", () => {
	const args = buildPlaybackSupervisorArgs("/tmp/pk-speak-audio/reply.mp3", {
		wait: false,
		cleanupDir: "/tmp/pk-speak-audio",
		allowOpenFallback: true,
	});
	assert.equal(args[1], "--supervise-playback");
	const payload = JSON.parse(Buffer.from(args[2], "base64url").toString("utf8"));
	assert.deepEqual(payload, {
		filePath: "/tmp/pk-speak-audio/reply.mp3",
		cleanupDir: "/tmp/pk-speak-audio",
		allowOpenFallback: true,
	});
});

test("Windows cancellation waits for taskkill to terminate the player process tree", async () => {
	const child = new EventEmitter();
	child.pid = 4242;
	child.exitCode = null;
	child.signalCode = null;
	child.kill = () => {
		throw new Error("taskkill should handle Windows process trees");
	};
	const taskkill = new EventEmitter();
	let invocation;
	const terminated = terminateAudioChild(child, "win32", (command, args, options) => {
		invocation = { command, args, options };
		queueMicrotask(() => taskkill.emit("close", 0));
		return taskkill;
	});
	await terminated;
	assert.deepEqual(invocation, {
		command: "taskkill.exe",
		args: ["/PID", "4242", "/T", "/F"],
		options: { stdio: "ignore", windowsHide: true, shell: false },
	});
});
