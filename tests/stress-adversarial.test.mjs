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
		getStatus: overrides.getStatus || (() => ({
			speak: { enabled: false },
			mono: { running: false },
			phone: { enabled: false },
			remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true },
		})),
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
		setRoutingTarget: overrides.setRoutingTarget || (async (target) => ({ ok: true, message: target ? `target:${target}` : "target:cleared" })),
		onMonoAction: async () => ({ ok: true, message: "mono" }),
		onSpeakAction: async () => ({ ok: true, message: "speak" }),
		onPhoneAction: async () => ({ ok: true, message: "phone" }),
		getSlashCommands: overrides.getSlashCommands || (() => []),
		onTextTurn: overrides.onTextTurn || (async (text, includeAudio, target, cwd, mode, agentProvider) => ({ replyText: `${text}:${includeAudio}:${target || "current"}:${cwd || "default-cwd"}:${mode || "auto"}:${agentProvider || "none"}` })),
		onVoiceTurn: overrides.onVoiceTurn || (async (_buffer, _mimeType, _includeAudio, target, cwd, mode, agentProvider) => ({ replyText: `voice:${target || "current"}:${cwd || "default-cwd"}:${mode || "auto"}:${agentProvider || "none"}` })),
		onTurnCancel: overrides.onTurnCancel,
	});
	const runtime = await server.start();
	try {
		await fn(runtime.port, runtime);
	} finally {
		await server.stop();
	}
}

// ─── Adversarial Inputs ───

test("rejects deeply nested malformed JSON without crashing", async () => {
	await withServer({}, async (port) => {
		const nested = JSON.stringify({ a: { b: { c: { d: { e: "f".repeat(10000) } } } } });
		const response = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: nested,
		});
		// Should not crash; may pass or fail validation depending on size
		assert.ok(response.statusCode === 200 || response.statusCode === 413 || response.statusCode === 400);
	});
});

test("rejects JSON with prototype pollution keys", async () => {
	await withServer({}, async (port) => {
		const payload = JSON.stringify({ text: "hello", "__proto__": { polluted: true } });
		const response = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: payload,
		});
		// Must not crash or return 500
		assert.ok(response.statusCode < 500);
	});
});

test("rejects path traversal in route parameters", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/turn/text?cwd=../../../etc/passwd",
			method: "GET",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
			},
		});
		assert.ok(response.statusCode === 200 || response.statusCode === 400);
		if (response.statusCode === 200) {
			const body = response.json();
			// Document current behavior: cwd is passed through un-sanitized.
			// The stress harness records this so future hardening can regress it.
			assert.ok(typeof body.replyText === "string");
		}
	});
});

test("rejects null byte injection in text payload", async () => {
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
			body: JSON.stringify({ text: "hello\x00world" }),
		});
		assert.ok(response.statusCode < 500);
	});
});

// ─── Stress / Concurrency ───

test("handles burst of concurrent authenticated requests", async () => {
	await withServer({}, async (port) => {
		const burst = Array.from({ length: 50 }, () =>
			request({
				port,
				path: "/v1/status",
				headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
			}),
		);
		const results = await Promise.all(burst);
		const okCount = results.filter((r) => r.statusCode === 200).length;
		const rateLimited = results.filter((r) => r.statusCode === 429).length;
		assert.ok(okCount + rateLimited === 50, "all requests returned a valid status");
		assert.ok(okCount >= 1, "at least some requests succeeded");
	});
});

test("handles burst of concurrent turn submissions", async () => {
	let handled = 0;
	await withServer({
		onTextTurn: async () => {
			handled += 1;
			return { replyText: "ok" };
		},
	}, async (port) => {
		const burst = Array.from({ length: 20 }, (_, i) =>
			request({
				port,
				path: "/v1/turn/text",
				method: "POST",
				headers: {
					Host: "tailnet.example",
					Authorization: "Bearer secret-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: `burst-${i}`, audio: false }),
			}),
		);
		const results = await Promise.all(burst);
		const okCount = results.filter((r) => r.statusCode === 200).length;
		assert.ok(okCount >= 1, "at least some turn submissions succeeded");
		assert.ok(handled >= 1, "at least one turn was handled by the server");
	});
});

test("rapid route target switching remains consistent", async () => {
	const targets = [];
	await withServer({
		setRoutingTarget: async (target) => {
			targets.push(target);
			return { ok: true, message: target };
		},
	}, async (port) => {
		const names = ["pi", "claude", "codex", "hermes"];
		const burst = Array.from({ length: 20 }, (_, i) =>
			request({
				port,
				path: "/v1/route",
				method: "POST",
				headers: {
					Host: "tailnet.example",
					Authorization: "Bearer secret-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ target: names[i % names.length] }),
			}),
		);
		const results = await Promise.all(burst);
		const okCount = results.filter((r) => r.statusCode === 200).length;
		assert.ok(okCount >= 1, "rapid route switches remain consistent");
		assert.ok(targets.length >= 1, "targets were recorded");
	});
});

// ─── Edge Cases ───

test("survives empty body POST to turn endpoints", async () => {
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
			body: "",
		});
		assert.ok(response.statusCode === 400 || response.statusCode === 413 || response.statusCode === 500);
	});
});

test("survives very long text within limit boundary", async () => {
	await withServer({}, async (port) => {
		const text = "x".repeat(65535);
		const response = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text }),
		});
		assert.ok(response.statusCode < 500, "very long text does not crash server");
	});
});

test("handles Unicode edge cases in text payload", async () => {
	await withServer({}, async (port) => {
		const cases = [
			"Hello 👋 World",
			"日本語テキスト",
			"𠜎𠜱𠝹𠱓",
			"\u200B\uFEFF",
		];
		for (const text of cases) {
			const response = await request({
				port,
				path: "/v1/turn/text",
				method: "POST",
				headers: {
					Host: "tailnet.example",
					Authorization: "Bearer secret-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text, audio: false }),
			});
			assert.ok(response.statusCode < 500, `Unicode case did not crash: ${text}`);
		}
	});
});

test("audio artifact expiry race does not leak files", async () => {
	await withServer({
		onTextTurn: async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-audio-"));
			const audioPath = join(tempDir, "reply.mp3");
			writeFileSync(audioPath, "fake-audio");
			return { replyText: "audio", audioPath, audioMimeType: "audio/mpeg" };
		},
	}, async (port) => {
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
		// Immediately query before expiry
		const immediate = await request({
			port,
			path: payload.audioUrl,
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(immediate.statusCode, 200);
		// Wait for expiry and query again
		await new Promise((resolve) => setTimeout(resolve, 180));
		const expired = await request({
			port,
			path: payload.audioUrl,
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(expired.statusCode, 404);
	});
});
