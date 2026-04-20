import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

process.env.PI_SPEAK_HTTP_AUDIO_TTL_MS = "50";
process.env.PI_SPEAK_HTTP_AUDIO_CLEANUP_MS = "25";

const { ControlServer } = await import("../dist/control-server.js");

function request({ port, path = "/", method = "GET", headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers,
			},
			(res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					resolve({
						statusCode: res.statusCode,
						headers: res.headers,
						body: data,
						json: () => JSON.parse(data),
					});
				});
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

async function withServer(overrides = {}, fn) {
	const server = new ControlServer({
		state: {
			enabled: false,
			host: "127.0.0.1",
			port: 0,
			authToken: "secret-token",
			...overrides.state,
		},
		onStateChange: () => {},
		getStatus: () => ({
			speak: { enabled: false },
			mono: { running: false },
			phone: { enabled: false },
			remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true },
		}),
		getDiagnostics: overrides.getDiagnostics || (() => ({
			status: {
				speak: { enabled: false },
				mono: { running: false },
				phone: { enabled: false },
				remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true },
			},
			lastErrors: {},
			recentTimings: {},
			queue: {},
			providers: {},
		})), 
		getRoutingStatus: () => ({
			defaultTarget: undefined,
			currentSession: "pi",
			availableTargets: ["pi", "claude", "codex", "hermes"],
		}),
		setRoutingTarget: async (target) => ({ ok: true, message: target ? `target:${target}` : "target:cleared" }),
		onMonoAction: async () => ({ ok: true, message: "mono" }),
		onSpeakAction: async () => ({ ok: true, message: "speak" }),
		onPhoneAction: async () => ({ ok: true, message: "phone" }),
		onTextTurn: overrides.onTextTurn || (async (text, includeAudio, target) => ({ replyText: `${text}:${includeAudio}:${target || "current"}` })),
		onVoiceTurn: overrides.onVoiceTurn || (async (_buffer, _mimeType, _includeAudio, target) => ({ replyText: `voice:${target || "current"}` })),
	});
	const runtime = await server.start();
	try {
		await fn(runtime.port);
	} finally {
		await server.stop();
	}
}

test("non-local status requires auth while localhost bypass still works", async () => {
	await withServer({}, async (port) => {
		const remoteResponse = await request({
			port,
			path: "/v1/status",
			headers: { Host: "tailnet.example" },
		});
		assert.equal(remoteResponse.statusCode, 401);

		const localResponse = await request({
			port,
			path: "/v1/status",
			headers: { Host: "localhost" },
		});
		assert.equal(localResponse.statusCode, 200);
		assert.equal(localResponse.json().ok, true);
	});
});

test("diagnostics route is authenticated for non-local requests", async () => {
	await withServer({}, async (port) => {
		const unauthorized = await request({
			port,
			path: "/v1/diagnostics",
			headers: { Host: "tailnet.example" },
		});
		assert.equal(unauthorized.statusCode, 401);

		const authorized = await request({
			port,
			path: "/v1/diagnostics",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(authorized.statusCode, 200);
		assert.equal(authorized.json().ok, true);
	});
});

test("diagnostics route includes a high-signal summary block", async () => {
	await withServer({
		getDiagnostics: () => ({
			status: {
				speak: { enabled: true },
				mono: { running: true, status: "active" },
				phone: { enabled: true, linkedChatId: 12345 },
				remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true, currentSession: "pi" },
			},
			lastErrors: { listener: "mic busy", remote: undefined, stt: "timeout" },
			recentTimings: {},
			queue: { processing: true, queued: 2 },
			providers: {},
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/diagnostics",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const payload = response.json();
		assert.equal(payload.diagnostics.summary.remoteEnabled, true);
		assert.equal(payload.diagnostics.summary.queueState, "busy");
		assert.equal(payload.diagnostics.summary.queueDepth, 2);
		assert.equal(payload.diagnostics.summary.phoneLinked, true);
		assert.equal(payload.diagnostics.summary.monoState, "active");
		assert.deepEqual(payload.diagnostics.summary.activeErrorSources, ["listener", "stt"]);
		assert.equal(payload.diagnostics.summary.currentSession, "pi");
		assert.equal(payload.diagnostics.summary.availableTargetCount, 4);
	});
});

test("oversized text body is rejected", async () => {
	await withServer({}, async (port) => {
		const body = JSON.stringify({ text: "x".repeat(70_000), audio: false });
		const response = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body,
		});
		assert.equal(response.statusCode, 413);
	});
});

test("unsupported voice content type is rejected", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/turn/voice",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "text/plain",
			},
			body: "not audio",
		});
		assert.equal(response.statusCode, 415);
	});
});

test("rate limiting rejects after control budget is exhausted", async () => {
	await withServer({}, async (port) => {
		for (let index = 0; index < 20; index += 1) {
			const response = await request({
				port,
				path: "/v1/status",
				headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
			});
			assert.equal(response.statusCode, 200);
		}
		const limited = await request({
			port,
			path: "/v1/status",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(limited.statusCode, 429);
		assert.equal(limited.json().busy, true);
	});
});

test("audio artifacts expire without a follow-up request", async () => {
	await withServer(
		{
			onTextTurn: async () => {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-audio-"));
				const audioPath = join(tempDir, "reply.mp3");
				writeFileSync(audioPath, "fake-audio");
				return { replyText: "audio", audioPath, audioMimeType: "audio/mpeg" };
			},
		},
		async (port) => {
			const response = await request({
				port,
				path: "/v1/turn/text",
				method: "POST",
				headers: {
					Host: "tailnet.example",
					Authorization: "Bearer secret-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: "audio" }),
			});
			assert.equal(response.statusCode, 200);
			const payload = response.json();
			assert.equal(typeof payload.audioUrl, "string");
			await new Promise((resolve) => setTimeout(resolve, 140));
			const expired = await request({
				port,
				path: payload.audioUrl,
				headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
			});
			assert.equal(expired.statusCode, 404);
		},
	);
});

test("audio artifacts reject query-token auth by default", async () => {
	await withServer(
		{
			onTextTurn: async () => {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-audio-"));
				const audioPath = join(tempDir, "reply.mp3");
				writeFileSync(audioPath, "fake-audio");
				return { replyText: "audio", audioPath, audioMimeType: "audio/mpeg" };
			},
		},
		async (port) => {
			const response = await request({
				port,
				path: "/v1/turn/text",
				method: "POST",
				headers: {
					Host: "tailnet.example",
					Authorization: "Bearer secret-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: "audio" }),
			});
			assert.equal(response.statusCode, 200);
			const payload = response.json();
			const unauthorized = await request({
				port,
				path: `${payload.audioUrl}?token=secret-token`,
				headers: { Host: "tailnet.example" },
			});
			assert.equal(unauthorized.statusCode, 401);
		},
	);
});

test("route endpoint reports and updates active target", async () => {
	await withServer({}, async (port) => {
		const route = await request({
			port,
			path: "/v1/route",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(route.statusCode, 200);
		assert.deepEqual(route.json().route.availableTargets, ["pi", "claude", "codex", "hermes"]);

		const updated = await request({
			port,
			path: "/v1/route",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ target: "codex" }),
		});
		assert.equal(updated.statusCode, 200);
		assert.equal(updated.json().message, "target:codex");
	});
});

test("mutating mono and speak routes reject GET and require POST", async () => {
	await withServer({}, async (port) => {
		const monoGet = await request({
			port,
			path: "/v1/mono/on",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(monoGet.statusCode, 405);

		const monoPost = await request({
			port,
			path: "/v1/mono/on",
			method: "POST",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(monoPost.statusCode, 200);

		const providerGet = await request({
			port,
			path: "/v1/speak/provider/edge",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(providerGet.statusCode, 405);

		const providerPost = await request({
			port,
			path: "/v1/speak/provider/edge",
			method: "POST",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(providerPost.statusCode, 200);
	});
});

test("turn routes accept an explicit target", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "hello", audio: false, target: "hermes" }),
		});
		assert.equal(response.statusCode, 200);
		assert.equal(response.json().replyText, "hello:false:hermes");
	});
});
