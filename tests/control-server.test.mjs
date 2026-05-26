import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import dgram from "node:dgram";

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
		setRoutingTarget: async (target) => ({ ok: true, message: target ? `target:${target}` : "target:cleared" }),
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

test("remote server exposes slash commands to authenticated app clients", async () => {
	await withServer({
		getSlashCommands: () => [
			{
				name: "sess",
				description: "Manage named sessions",
				usage: "/sess [list|slots]",
				examples: ["/sess", "/sess slots"],
				source: "extension",
			},
		],
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/commands",
			headers: { "X-Pi-Speak-Token": "secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const payload = response.json();
		assert.equal(payload.ok, true);
		assert.equal(payload.commands[0].name, "sess");
		assert.deepEqual(payload.commands[0].examples, ["/sess", "/sess slots"]);
	});
});

async function withTemporaryEnv(name, value, fn) {
	const previous = process.env[name];
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = previous;
		}
	}
}

test("remote server generates an install token when no token is configured", async () => {
	await withTemporaryEnv("PI_SPEAK_HTTP_TOKEN", undefined, async () => {
		const configDir = mkdtempSync(join(tmpdir(), "pi-speak-config-"));
		await withTemporaryEnv("PI_SPEAK_CONFIG_DIR", configDir, async () => withServer({ state: { authToken: undefined } }, async (port, runtime) => {
			assert.notEqual(runtime.authToken, "P-K-Haxx1!");
			assert.ok(runtime.authToken.length >= 24);
			const unauthorized = await request({
				port,
				path: "/v1/status",
				headers: { Host: "tailnet.example" },
			});
			assert.equal(unauthorized.statusCode, 401);

			const authorized = await request({
				port,
				path: "/v1/status",
				headers: {
					Host: "tailnet.example",
					Authorization: `Bearer ${runtime.authToken}`,
				},
			});
			assert.equal(authorized.statusCode, 200);
			assert.equal(authorized.json().ok, true);
		}));
	});
});

test("public health and discovery descriptor do not expose auth token", async () => {
	await withServer({}, async (port) => {
		const health = await request({
			port,
			path: "/health",
			headers: { Host: "tailnet.example" },
		});
		assert.equal(health.statusCode, 200);
		assert.equal(health.json().app, "pi-speak");

		const discovery = await request({
			port,
			path: "/.well-known/pi-speak",
			headers: { Host: "tailnet.example" },
		});
		assert.equal(discovery.statusCode, 200);
		const descriptor = discovery.json();
		assert.equal(descriptor.schema, "pi-speak.discovery.v1");
		assert.equal(descriptor.authRequired, true);
		assert.equal(descriptor.endpoints.cancelTurn, "/v1/turn/cancel");
		assert.doesNotMatch(discovery.body, /secret-token|P-K-Haxx1!/);
	});
});

test("udp discovery responder announces descriptor without token", async () => {
	const discoveryPort = 19_000 + Math.floor(Math.random() * 1000);
	await withTemporaryEnv("PI_SPEAK_DISCOVERY_PORT", String(discoveryPort), async () => {
		await withServer({}, async (port) => {
			const announcement = await new Promise((resolve, reject) => {
				const socket = dgram.createSocket("udp4");
				const timer = setTimeout(() => {
					socket.close();
					reject(new Error("timed out waiting for UDP discovery announcement"));
				}, 1000);
				socket.on("message", (message) => {
					clearTimeout(timer);
					socket.close();
					resolve(JSON.parse(message.toString("utf8")));
				});
				socket.bind(0, "127.0.0.1", () => {
					const payload = Buffer.from(JSON.stringify({
						type: "pi-speak.discover",
						version: 1,
						nonce: "test-nonce",
					}));
					socket.send(payload, discoveryPort, "127.0.0.1");
				});
			});
			assert.equal(announcement.type, "pi-speak.announce");
			assert.equal(announcement.nonce, "test-nonce");
			assert.equal(announcement.httpPort, port);
			assert.equal(announcement.authRequired, true);
			assert.equal(announcement.descriptorPath, "/.well-known/pi-speak");
			assert.doesNotMatch(JSON.stringify(announcement), /secret-token|P-K-Haxx1!/);
		});
	});
});

test("turn cancellation route invokes the cancel handler", async () => {
	let cancelled = false;
	await withServer({
		onTurnCancel: async () => {
			cancelled = true;
			return { ok: true, message: "cancelled" };
		},
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/turn/cancel",
			method: "POST",
			headers: { Host: "tailnet.example", Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		assert.equal(response.json().message, "cancelled");
		assert.equal(cancelled, true);
	});
});

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

test("phone setup page is public and includes install plus connect links", async () => {
	await withServer({
		getStatus: () => ({
			agent: { provider: "elevenlabs", configuredProvider: "elevenlabs", capabilities: { textTurns: true, voiceTurns: true, audioReplies: true, routing: true, steering: false } },
			speak: { enabled: false },
			mono: { running: false },
			phone: { enabled: false },
			remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true, currentSession: "pi" },
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/setup?token=secret-token&profile_name=Test%20Rig",
			headers: { Host: `100.76.136.91:${port}` },
		});
		assert.equal(response.statusCode, 200);
		assert.match(response.headers["content-type"], /text\/html/);
		assert.match(response.body, /Pi Speak phone setup/);
		assert.match(response.body, /download\/pi-speak\.apk/);
		assert.match(response.body, /pi-speak:\/\/setup/);
		assert.match(response.body, /token=secret-token/);
		assert.match(response.body, /agent_provider=elevenlabs/);
		assert.match(response.body, /Test Rig/);

		const downloadRedirect = await request({
			port,
			path: "/download",
			headers: { Host: `100.76.136.91:${port}` },
		});
		assert.equal(downloadRedirect.statusCode, 302);
		assert.equal(downloadRedirect.headers.location, "/download/pi-speak.apk");
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
		assert.equal(typeof payload.diagnostics.discovery.udpEnabled, "boolean");
		assert.equal(typeof payload.diagnostics.discovery.udpPort, "number");
		assert.equal(typeof payload.diagnostics.discovery.mdnsEnabled, "boolean");
		assert.equal(payload.diagnostics.discovery.mdnsService, "_pispeak._tcp.local");
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

test("POST route rejects malformed JSON payload", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/route",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: "not-json",
		});
		assert.equal(response.statusCode, 400);
		assert.equal(response.json().error, "Invalid JSON body.");
	});
});

test("POST turn/text rejects malformed JSON payload", async () => {
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
			body: "not-json",
		});
		assert.equal(response.statusCode, 400);
		assert.equal(response.json().error, "Invalid JSON body.");
	});
});

test("POST turn/text rejects non-string text payload", async () => {
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
			body: JSON.stringify({ text: 123 }),
		});
		assert.equal(response.statusCode, 400);
		assert.equal(response.json().error, "Invalid payload: text is required.");
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
		assert.equal(response.json().replyText, "hello:false:hermes:default-cwd:auto:none");
	});
});

test("turn routes accept an explicit launch cwd", async () => {
	await withServer({}, async (port) => {
		const textResponse = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "hello", audio: false, target: "codex", cwd: "C:\\dev\\project" }),
		});
		assert.equal(textResponse.statusCode, 200);
		assert.equal(textResponse.json().replyText, "hello:false:codex:C:\\dev\\project:auto:none");

		const voiceResponse = await request({
			port,
			path: "/v1/turn/voice?audio=0&target=codex&cwd=C%3A%5Cdev%5Cproject",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "audio/wav",
			},
			body: "fake-wav",
		});
		assert.equal(voiceResponse.statusCode, 200);
		assert.equal(voiceResponse.json().replyText, "voice:codex:C:\\dev\\project:auto:none");
	});
});

test("turn routes accept an explicit agent provider override", async () => {
	const seen = [];
	await withServer({
		onTextTurn: async (text, includeAudio, target, cwd, mode, agentProvider) => {
			seen.push({ text, includeAudio, target, cwd, mode, agentProvider });
			return { replyText: "ok" };
		},
		onVoiceTurn: async (_buffer, _mimeType, includeAudio, target, cwd, mode, agentProvider) => {
			seen.push({ includeAudio, target, cwd, mode, agentProvider });
			return { replyText: "ok" };
		},
	}, async (port) => {
		const textResponse = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "hello", audio: false, agentProvider: "codex" }),
		});
		assert.equal(textResponse.statusCode, 200);

		const textGetResponse = await request({
			port,
			path: "/v1/turn/text?text=hello&audio=0&agentProvider=pi",
			method: "GET",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
			},
		});
		assert.equal(textGetResponse.statusCode, 200);

		const voiceResponse = await request({
			port,
			path: "/v1/turn/voice?audio=0&agentProvider=pi",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "audio/wav",
			},
			body: "fake-wav",
		});
		assert.equal(voiceResponse.statusCode, 200);
	});

	assert.deepEqual(seen[0], {
		text: "hello",
		includeAudio: false,
		target: undefined,
		cwd: undefined,
		mode: "auto",
		agentProvider: "codex",
	});
	assert.deepEqual(seen[1], {
		text: "hello",
		includeAudio: false,
		target: undefined,
		cwd: undefined,
		mode: "auto",
		agentProvider: "pi",
	});
	assert.deepEqual(seen[2], {
		includeAudio: false,
		target: undefined,
		cwd: undefined,
		mode: "auto",
		agentProvider: "pi",
	});
});
