import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { Buffer } from "node:buffer";

// Deterministic offline providers for the cascade endpoints.
process.env.PI_SPEAK_REMOTE_STT_BACKEND = "moonshine";
process.env.PI_SPEAK_TTS_PROVIDER = "gemini";
process.env.PI_SPEAK_REWRITE_ENABLED = "0";
process.env.PI_SPEAK_HTTP_SPEECH_TTL_MS = "60";
const previousUserprofile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
const userRoot = mkdtempSync(join(tmpdir(), "pi-speak-cascade-user-"));
process.env.USERPROFILE = userRoot;
process.env.HOME = userRoot;
process.on("exit", () => {
	if (previousUserprofile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserprofile;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(userRoot, { recursive: true, force: true });
});

const { ControlServer } = await import("../dist/control-server.js");
const { testOverrides: sttOverrides } = await import("../dist/stt.js");
const { testOverrides: ttsOverrides } = await import("../dist/tts.js");

function request({ port, path = "/", method = "GET", headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				let parsed;
				try { parsed = JSON.parse(buf.toString("utf8")); } catch { parsed = undefined; }
				resolve({ statusCode: res.statusCode, headers: res.headers, body: buf, json: parsed });
			});
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const AUTH = { "x-pi-speak-token": "secret-token" };

async function withServer(fn) {
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
	});
	const runtime = await server.start();
	try {
		await fn(runtime.port);
	} finally {
		await server.stop();
	}
}

test("POST /v1/cascade/transcribe returns the transcript and provider without touching a session", async () => {
	sttOverrides.transcribeWithMoonshine = async (filePath) => {
		assert.ok(filePath.endsWith(".webm"), "mime type drives the temp file extension");
		return "how are my agents doing";
	};
	try {
		await withServer(async (port) => {
			const res = await request({
				port,
				path: "/v1/cascade/transcribe",
				method: "POST",
				headers: { ...AUTH, "Content-Type": "audio/webm" },
				body: Buffer.from("fake-webm-audio"),
			});
			assert.equal(res.statusCode, 200);
			assert.equal(res.json.ok, true);
			assert.equal(res.json.text, "how are my agents doing");
			assert.equal(res.json.provider, "moonshine");
		});
	} finally {
		sttOverrides.transcribeWithMoonshine = null;
	}
});

test("POST /v1/cascade/transcribe rejects non-audio bodies and empty audio", async () => {
	await withServer(async (port) => {
		const wrongType = await request({
			port,
			path: "/v1/cascade/transcribe",
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: Buffer.from("{}"),
		});
		assert.equal(wrongType.statusCode, 415);

		const empty = await request({
			port,
			path: "/v1/cascade/transcribe",
			method: "POST",
			headers: { ...AUTH, "Content-Type": "audio/webm" },
			body: Buffer.alloc(0),
		});
		assert.equal(empty.statusCode, 400);
	});
});

test("POST /v1/cascade/transcribe inherits the standard gate: loopback needs no token", async () => {
	// The gateway's auth contract bypasses the token for local requests (the remote
	// token path is covered by the pre-existing /v1/speak gate tests). Pin that the
	// cascade route sits behind the same gate rather than adding a second one.
	sttOverrides.transcribeWithMoonshine = async () => "local request, no token";
	try {
		await withServer(async (port) => {
			const res = await request({
				port,
				path: "/v1/cascade/transcribe",
				method: "POST",
				headers: { "Content-Type": "audio/webm" },
				body: Buffer.from("fake-webm-audio"),
			});
			assert.equal(res.statusCode, 200);
			assert.equal(res.json.ok, true);
		});
	} finally {
		sttOverrides.transcribeWithMoonshine = null;
	}
});

test("POST /v1/cascade/speak synthesizes through the TTS chain and stages a playable artifact", async () => {
	ttsOverrides.synthesizeGemini = async (text, outputPath) => {
		assert.equal(text, "Three running, one idle.");
		writeFileSync(outputPath, "fake-tts-audio");
	};
	// Cover machines without Gemini auth: the auto fallback chain may land on edge.
	ttsOverrides.synthesizeEdge = async (text, outputPath) => {
		writeFileSync(outputPath, "fake-tts-audio");
	};
	try {
		await withServer(async (port) => {
			const res = await request({
				port,
				path: "/v1/cascade/speak",
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: Buffer.from(JSON.stringify({ text: "Three running, one idle." })),
			});
			assert.equal(res.statusCode, 200);
			assert.equal(res.json.ok, true);
			assert.ok(res.json.audioUrl.startsWith("/v1/speech/audio/"));

			// The artifact plays through the standard speech audio route.
			const audio = await request({ port, path: res.json.audioUrl, method: "GET", headers: AUTH });
			assert.equal(audio.statusCode, 200);
			assert.equal(audio.body.toString("utf8"), "fake-tts-audio");

			// And its metadata is staged like terminal-initiated speech.
			const meta = await request({ port, path: res.json.stagedUrl, method: "GET", headers: AUTH });
			assert.equal(meta.statusCode, 200);
			assert.equal(meta.json.text, "Three running, one idle.");
		});
	} finally {
		ttsOverrides.synthesizeGemini = null;
		ttsOverrides.synthesizeEdge = null;
	}
});

test("unknown /v1/cascade path returns 404, not a fall-through", async () => {
	await withServer(async (port) => {
		const res = await request({ port, path: "/v1/cascade/nope", method: "POST", headers: AUTH });
		assert.equal(res.statusCode, 404);
	});
});

test("POST /v1/cascade/speak rejects empty and oversized text", async () => {
	await withServer(async (port) => {
		const empty = await request({
			port,
			path: "/v1/cascade/speak",
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: Buffer.from(JSON.stringify({ text: "   " })),
		});
		assert.equal(empty.statusCode, 400);

		const oversized = await request({
			port,
			path: "/v1/cascade/speak",
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: Buffer.from(JSON.stringify({ text: "x".repeat(9000) })),
		});
		assert.equal(oversized.statusCode, 400);
		assert.match(oversized.json.error, /exceeds/);
	});
});
