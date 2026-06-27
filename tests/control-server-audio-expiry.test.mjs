import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// Short TTL, but a cleanup interval long enough that the periodic sweep never
// fires during this test. That isolates READ-TIME expiry enforcement: if the
// audio endpoint only relied on the sweep, an expired artifact would still be
// served here (200) because the sweep hasn't run. It must return 404 anyway.
process.env.PI_SPEAK_HTTP_AUDIO_TTL_MS = "40";
process.env.PI_SPEAK_HTTP_AUDIO_CLEANUP_MS = "3600000";

const { ControlServer } = await import("../dist/control-server.js");
function request({ port, path = "/", method = "GET", headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				data += chunk;
			});
			res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function withServer(overrides, fn) {
	const server = new ControlServer({
		state: { enabled: false, host: "127.0.0.1", port: 0, authToken: "secret-token" },
		onStateChange: () => {},
		getStatus: () => ({ speak: { enabled: false }, mono: { running: false }, phone: { enabled: false }, remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true } }),
		getDiagnostics: () => ({ status: {}, lastErrors: {}, recentTimings: {}, queue: {}, providers: {} }),
		getRoutingStatus: () => ({ defaultTarget: undefined, currentSession: "pi", availableTargets: ["pi"] }),
		setRoutingTarget: async () => ({ ok: true, message: "ok" }),
		onMonoAction: async () => ({ ok: true, message: "mono" }),
		onSpeakAction: async () => ({ ok: true, message: "speak" }),
		onPhoneAction: async () => ({ ok: true, message: "phone" }),
		getSlashCommands: () => [],
		onTextTurn: overrides.onTextTurn,
		onVoiceTurn: async () => ({ replyText: "voice" }),
	});
	const runtime = await server.start();
	try {
		await fn(runtime.port);
	} finally {
		await server.stop();
	}
}

test("audio endpoint enforces TTL at read time even when the cleanup sweep has not run", async () => {
	await withServer(
		{
			onTextTurn: async () => {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-audio-rt-"));
				const audioPath = join(tempDir, "reply.mp3");
				writeFileSync(audioPath, "fake-audio");
				return { replyText: "audio", audioPath, audioMimeType: "audio/mpeg" };
			},
		},
		async (port) => {
			const turn = await request({
				port,
				path: "/v1/turn/text",
				method: "POST",
				headers: { Host: "tailnet.example", Authorization: "Bearer secret-token", "Content-Type": "application/json" },
				body: JSON.stringify({ text: "audio" }),
			});
			// Body omitted is fine for the stub onTextTurn; it ignores text.
			assert.equal(turn.statusCode, 200);
			const audioUrl = JSON.parse(turn.body).audioUrl;
			assert.equal(typeof audioUrl, "string");

			// Before TTL: served.
			const fresh = await request({ port, path: audioUrl, headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" } });
			assert.equal(fresh.statusCode, 200, "fresh artifact is served");

			// Wait past the 40ms TTL. The cleanup sweep is set to 1h, so it has NOT
			// run — only the read-time guard can make this 404.
			await new Promise((r) => setTimeout(r, 80));
			const expired = await request({ port, path: audioUrl, headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" } });
			assert.equal(expired.statusCode, 404, "expired artifact must 404 from the read-time guard, not the sweep");
		},
	);
});
