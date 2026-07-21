import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { Buffer } from "node:buffer";

// Short TTL so the expiry sweep is testable without long waits.
process.env.PI_SPEAK_HTTP_SPEECH_TTL_MS = "60";
process.env.PI_SPEAK_HTTP_SPEECH_BODY_LIMIT_BYTES = "65536";

// Isolate the hard-stop sentinel paths so isRootVoiceDisabled() reads only
// state we set inside tests, not the dev machine's. The disable sentinel
// lives under getPiSpeakConfigDir() (PI_SPEAK_CONFIG_DIR > LOCALAPPDATA >
// APPDATA) and ~\.omp\agent\speech-disabled (USERPROFILE > HOME).
const previousConfigDir = process.env.PI_SPEAK_CONFIG_DIR;
const previousUserprofile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
const brokerRoot = mkdtempSync(join(tmpdir(), "pi-speak-speech-broker-"));
const userRoot = mkdtempSync(join(tmpdir(), "pi-speak-speech-user-"));
process.env.PI_SPEAK_CONFIG_DIR = join(brokerRoot, "pi-speak");
process.env.USERPROFILE = userRoot;
process.env.HOME = userRoot;
process.on("exit", () => {
	if (previousConfigDir === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
	else process.env.PI_SPEAK_CONFIG_DIR = previousConfigDir;
	if (previousUserprofile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserprofile;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(brokerRoot, { recursive: true, force: true });
	rmSync(userRoot, { recursive: true, force: true });
});
const { ControlServer } = await import("../dist/control-server.js");

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

test("POST /v1/speech/stage accepts raw audio bytes and returns an id; text travels in base64url header", async () => {
	await withServer(async (port) => {
		const text = "Hello with emoji 🚀 and newline\nsecond line.";
		const encoded = Buffer.from(text, "utf8").toString("base64url");
		const stage = await request({
			port,
			path: "/v1/speech/stage",
			method: "POST",
			headers: { "Content-Type": "audio/mpeg", "X-Pi-Speak-Speech-Text-B64": encoded },
			body: Buffer.from("fake-mp3-bytes"),
		});
		assert.equal(stage.statusCode, 200);
		assert.ok(stage.json.id);
		assert.equal(stage.json.audioUrl, `/v1/speech/audio/${stage.json.id}`);

		// Metadata endpoint returns decoded text verbatim (Unicode survived).
		const meta = await request({ port, path: `/v1/speech/staged/${stage.json.id}`, method: "GET" });
		assert.equal(meta.statusCode, 200);
		assert.equal(meta.json.text, text);
		assert.equal(meta.json.speechDisabled, false);

		// Audio bytes served.
		const audio = await request({ port, path: `/v1/speech/audio/${stage.json.id}`, method: "GET" });
		assert.equal(audio.statusCode, 200);
		assert.equal(audio.headers["content-type"], "audio/mpeg");
		assert.equal(audio.body.toString("utf8"), "fake-mp3-bytes");
	});
});

test("POST /v1/speech/stage rejects disallowed MIME types without reading the body", async () => {
	await withServer(async (port) => {
		const res = await request({
			port,
			path: "/v1/speech/stage",
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: Buffer.from("not audio"),
		});
		assert.equal(res.statusCode, 415);
		assert.match(res.json.error, /unsupported audio mime/i);
	});
});

test("POST /v1/speech/stage rejects empty audio body", async () => {
	await withServer(async (port) => {
		const res = await request({
			port,
			path: "/v1/speech/stage",
			method: "POST",
			headers: { "Content-Type": "audio/mpeg" },
			body: Buffer.alloc(0),
		});
		assert.equal(res.statusCode, 400);
		assert.match(res.json.error, /empty audio body/i);
	});
});

test("unknown /v1/speech/* path returns 404, not a fall-through", async () => {
	await withServer(async (port) => {
		const res = await request({ port, path: "/v1/speech/nonsense", method: "GET" });
		assert.equal(res.statusCode, 404);
	});
});

test("expired staged artifact returns 404 at read time (sweep-independent)", async () => {
	await withServer(async (port) => {
		const stage = await request({
			port,
			path: "/v1/speech/stage",
			method: "POST",
			headers: { "Content-Type": "audio/mpeg" },
			body: Buffer.from("short"),
		});
		assert.equal(stage.statusCode, 200);
		// TTL is 60ms — wait long enough for read-time check to trip.
		await new Promise((resolve) => setTimeout(resolve, 120));
		const meta = await request({ port, path: `/v1/speech/staged/${stage.json.id}`, method: "GET" });
		assert.equal(meta.statusCode, 404);
	});
});

test("POST /v1/speech/disable flips the hard-stop sentinel; /enable clears it", async () => {
	await withServer(async (port) => {
		const before = await request({ port, path: "/v1/speech/disabled", method: "GET" });
		assert.equal(before.json.disabled, false);

		const disable = await request({ port, path: "/v1/speech/disable", method: "POST" });
		assert.equal(disable.statusCode, 200);
		assert.equal(disable.json.disabled, true);

		const between = await request({ port, path: "/v1/speech/disabled", method: "GET" });
		assert.equal(between.json.disabled, true);

		const enable = await request({ port, path: "/v1/speech/enable", method: "POST" });
		assert.equal(enable.statusCode, 200);
		assert.equal(enable.json.disabled, false);

		const after = await request({ port, path: "/v1/speech/disabled", method: "GET" });
		assert.equal(after.json.disabled, false);
	});
});
