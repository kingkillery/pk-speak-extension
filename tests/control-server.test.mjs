import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import dgram from "node:dgram";

process.env.PI_SPEAK_HTTP_AUDIO_TTL_MS = "50";
process.env.PI_SPEAK_HTTP_AUDIO_CLEANUP_MS = "25";

const { ControlServer } = await import("../dist/control-server.js");

function request({ port, path = "/", method = "GET", headers = {}, body, host = "127.0.0.1" }) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host,
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
		getSessionDashboard: overrides.getSessionDashboard,
		getCompactRouteSlots: overrides.getCompactRouteSlots,
		onSessionRename: overrides.onSessionRename,
		onSessionAlias: overrides.onSessionAlias,
		onSessionRemove: overrides.onSessionRemove,
		onSessionResume: overrides.onSessionResume,
		onSessionLaunch: overrides.onSessionLaunch,
		onSessionArchive: overrides.onSessionArchive,
		onHubPublish: overrides.onHubPublish,
		onHubResume: overrides.onHubResume,
		isHubHandoffReady: overrides.isHubHandoffReady,
		onOmpSelectSession: overrides.onOmpSelectSession,
		onOmpGetSelectedSession: overrides.onOmpGetSelectedSession,
		getDiscoveredAgents: overrides.getDiscoveredAgents,
		getHerdrSnapshot: overrides.getHerdrSnapshot,
		readHerdrPane: overrides.readHerdrPane,
		sendHerdrPane: overrides.sendHerdrPane,
		sendHerdrAgent: overrides.sendHerdrAgent,
		tailSessionEvents: overrides.tailSessionEvents,
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
		assert.equal(descriptor.pairing.required, true);
		assert.equal(descriptor.pairing.tokenDelivery, "setup-qr-only");
		assert.equal(descriptor.security.publicDiscoveryIncludesToken, false);
		assert.equal(descriptor.endpoints.cancelTurn, "/v1/turn/cancel");
		assert.equal(descriptor.endpoints.sessionLaunch, "/v1/sessions/launch");
		assert.ok(descriptor.capabilities.includes("session-launch"));
		assert.ok(descriptor.capabilities.includes("colab-launch"));
		assert.equal(descriptor.capabilities.includes("hub-handoff"), false);
		assert.doesNotMatch(discovery.body, /secret-token|P-K-Haxx1!/);
	});
});

test("setup page carries token only when launched from pairing URL", async () => {
	await withServer({}, async (port) => {
		const publicSetup = await request({
			port,
			path: "/setup",
			headers: { Host: "tailnet.example" },
		});
		assert.equal(publicSetup.statusCode, 200);
		assert.doesNotMatch(publicSetup.body, /[?&](amp;)?token=/);

		const pairedSetup = await request({
			port,
			path: "/setup?token=secret-token&profile_name=Main",
			headers: { Host: "tailnet.example" },
		});
		assert.equal(pairedSetup.statusCode, 200);
		assert.match(pairedSetup.body, /token=secret-token/);
		assert.match(pairedSetup.body, /no IP address or API key entry is needed/i);
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
			headers: { Host: `100.64.0.10:${port}` },
		});
		assert.equal(response.statusCode, 200);
		assert.match(response.headers["content-type"], /text\/html/);
		assert.match(response.body, /Pair Pi Speak/);
		assert.match(response.body, /no IP address or API key entry is needed/i);
		assert.match(response.body, /download\/pi-speak\.apk|APK is not bundled/);
		assert.match(response.body, /pi-speak:\/\/setup/);
		assert.match(response.body, /token=secret-token/);
		assert.match(response.body, /agent_provider=elevenlabs/);
		assert.match(response.body, /Test Rig/);

		const downloadRedirect = await request({
			port,
			path: "/download",
			headers: { Host: `100.64.0.10:${port}` },
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
		onTextTurn: async (text, includeAudio, target, cwd, mode, agentProvider, model) => {
			seen.push({ text, includeAudio, target, cwd, mode, agentProvider, model });
			return { replyText: "ok" };
		},
		onVoiceTurn: async (_buffer, _mimeType, includeAudio, target, cwd, mode, agentProvider, model) => {
			seen.push({ includeAudio, target, cwd, mode, agentProvider, model });
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
			body: JSON.stringify({ text: "hello", audio: false, agentProvider: "codex", model: "gpt-test" }),
		});
		assert.equal(textResponse.statusCode, 200);

		const textGetResponse = await request({
			port,
			path: "/v1/turn/text?text=hello&audio=0&agentProvider=pi&model=gpt-get",
			method: "GET",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
			},
		});
		assert.equal(textGetResponse.statusCode, 200);

		const voiceResponse = await request({
			port,
			path: "/v1/turn/voice?audio=0&agentProvider=pi&model=gpt-voice",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "audio/wav",
			},
			body: "fake-wav",
		});
		assert.equal(voiceResponse.statusCode, 200);

		const claudeResponse = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "resume this in claude", audio: false, agentProvider: "claude" }),
		});
		assert.equal(claudeResponse.statusCode, 200);
	});

	assert.deepEqual(seen[0], {
		text: "hello",
		includeAudio: false,
		target: undefined,
		cwd: undefined,
		mode: "auto",
		agentProvider: "codex",
		model: "gpt-test",
	});
	assert.deepEqual(seen[1], {
		text: "hello",
		includeAudio: false,
		target: undefined,
		cwd: undefined,
		mode: "auto",
		agentProvider: "pi",
		model: "gpt-get",
	});
	assert.deepEqual(seen[2], {
		includeAudio: false,
		target: undefined,
		cwd: undefined,
		mode: "auto",
		agentProvider: "pi",
		model: "gpt-voice",
	});
	assert.deepEqual(seen[3], {
		text: "resume this in claude",
		includeAudio: false,
		target: undefined,
		cwd: undefined,
		mode: "auto",
		agentProvider: "claude",
		model: undefined,
	});
});


test("turn routes normalize the oh-my-pk agent provider override and legacy aliases", async () => {
	const seen = [];
	await withServer({
		onTextTurn: async (text, includeAudio, target, cwd, mode, agentProvider) => {
			seen.push({ text, agentProvider });
			return { replyText: `provider:${agentProvider || "none"}` };
		},
		onVoiceTurn: async (_buffer, _mimeType, _includeAudio, _target, _cwd, _mode, agentProvider) => {
			seen.push({ voice: true, agentProvider });
			return { replyText: `voice-provider:${agentProvider || "none"}` };
		},
	}, async (port) => {
		const canonical = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "run it", audio: false, agentProvider: "oh-my-pk" }),
		});
		assert.equal(canonical.statusCode, 200);
		assert.equal(canonical.json().replyText, "provider:oh-my-pk");

		const alias = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "run it", audio: false, agentProvider: "ompk" }),
		});
		assert.equal(alias.statusCode, 200);
		assert.equal(alias.json().replyText, "provider:oh-my-pk");

		const legacyAlias = await request({
			port,
			path: "/v1/turn/text",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "run it", audio: false, agentProvider: "omp" }),
		});
		assert.equal(legacyAlias.statusCode, 200);
		assert.equal(legacyAlias.json().replyText, "provider:oh-my-pk");

		const voiceAlias = await request({
			port,
			path: "/v1/turn/voice?audio=0&agentProvider=OMP",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				Authorization: "Bearer secret-token",
				"Content-Type": "audio/wav",
			},
			body: "fake-wav",
		});
		assert.equal(voiceAlias.statusCode, 200);
		assert.equal(voiceAlias.json().replyText, "voice-provider:oh-my-pk");
	});

	assert.deepEqual(seen, [
		{ text: "run it", agentProvider: "oh-my-pk" },
		{ text: "run it", agentProvider: "oh-my-pk" },
		{ text: "run it", agentProvider: "oh-my-pk" },
		{ voice: true, agentProvider: "oh-my-pk" },
	]);
});

test("session dashboard endpoint returns dashboard when callback is provided", async () => {
	await withServer({
		getSessionDashboard: () => ({ current: "pi", ready: ["claude"], sessions: [{ name: "pi", current: true, ready: true, activity: "idle", aliases: [], workingDirectory: "C:\\dev\\pi" }] }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions",
			method: "GET",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.dashboard.current, "pi");
		assert.equal(body.dashboard.sessions[0].workingDirectory, "C:\\dev\\pi");
	});
});

test("session dashboard endpoint returns 501 when callback is missing", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions",
			method: "GET",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 501);
		const body = await response.json();
		assert.equal(body.ok, false);
	});
});

test("route slots endpoint returns slots when callback is provided", async () => {
	await withServer({
		getCompactRouteSlots: () => [{ family: "1", sessionName: "pi", labels: ["one"], status: "mapped" }],
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/slots",
			method: "GET",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.slots.length, 1);
		assert.equal(body.slots[0].family, "1");
	});
});

test("session rename endpoint invokes callback and returns result", async () => {
	await withServer({
		onSessionRename: async (payload) => ({ ok: true, message: `renamed:${payload.newName}` }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/rename",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionPath: "/tmp/pi.json", newName: "alpha" }),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "renamed:alpha");
	});
});

test("session alias endpoint invokes callback and returns result", async () => {
	await withServer({
		onSessionAlias: async (payload) => ({ ok: true, message: `aliased:${payload.alias}` }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/alias",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionPath: "/tmp/pi.json", alias: "one" }),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "aliased:one");
	});
});

test("session remove endpoint invokes callback and returns result", async () => {
	await withServer({
		onSessionRemove: async (payload) => ({ ok: true, message: `removed:${payload.sessionPath}` }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/remove",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionPath: "/tmp/pi.json" }),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "removed:/tmp/pi.json");
	});
});

test("hub publish endpoint returns the fragment-bearing link without caching", async () => {
	await withServer({
		onHubPublish: async (payload) => ({
			ok: true,
			message: "published",
			sessionPath: payload.sessionPath,
			link: "https://relay.example/h/hub_alpha01#secret-key",
		}),
		onHubResume: async () => ({ ok: true, message: "resumed" }),
		isHubHandoffReady: () => true,
	}, async (port) => {
		const discovery = await request({ port, path: "/.well-known/pi-speak" });
		assert.equal(discovery.json().capabilities.includes("hub-handoff"), true);

		const response = await request({
			port,
			path: "/v1/hub/publish",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionPath: "C:\\sessions\\active.jsonl" }),
		});
		assert.equal(response.statusCode, 200);
		assert.equal(response.headers["cache-control"], "no-store");
		const body = await response.json();
		assert.equal(body.link, "https://relay.example/h/hub_alpha01#secret-key");
		assert.equal(body.sessionPath, "C:\\sessions\\active.jsonl");
	});
});

test("hub resume endpoint keeps the submitted key out of its response", async () => {
	const link = "https://relay.example/h/hub_alpha01#secret-key";
	await withServer({
		onHubResume: async (payload) => ({
			ok: true,
			message: "resumed",
			sessionPath: "C:\\sessions\\imported.jsonl",
			hubId: new URL(payload.link).pathname.split("/").at(-1),
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/hub/resume",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ link }),
		});
		assert.equal(response.statusCode, 200);
		assert.equal(response.headers["cache-control"], "no-store");
		assert.doesNotMatch(response.body, /secret-key/);
		assert.equal((await response.json()).sessionPath, "C:\\sessions\\imported.jsonl");
	});
});

test("hub handoff endpoints return 501 when no owner adapter is available", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/hub/publish",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionPath: "C:\\sessions\\active.jsonl" }),
		});
		assert.equal(response.statusCode, 501);
		assert.equal(response.headers["cache-control"], "no-store");
	});
});
test("unauthorized hub responses are non-cacheable", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/hub/resume",
			method: "POST",
			headers: {
				Host: "tailnet.example",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ link: "https://relay.example/h/hub_alpha01#secret-key" }),
		});
		assert.equal(response.statusCode, 401);
		assert.equal(response.headers["cache-control"], "no-store");
	});
});


test("session resume endpoint invokes callback and returns result", async () => {
	await withServer({
		onSessionResume: async (payload) => ({
			ok: true,
			message: `resume:${payload.provider}:${payload.sessionId}:${payload.sessionPath}:${payload.cwd}`,
			command: ["codex", "resume", payload.sessionId],
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/resume",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: "codex",
				sessionId: "abc123",
				sessionPath: "C:\\Users\\example\\.codex\\sessions\\session.jsonl",
				cwd: "C:\\dev\\project",
			}),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "resume:codex:abc123:C:\\Users\\example\\.codex\\sessions\\session.jsonl:C:\\dev\\project");
		assert.deepEqual(body.command, ["codex", "resume", "abc123"]);
	});
});

test("session resume endpoint requires sessionPath or sessionId", async () => {
	await withServer({
		onSessionResume: async () => ({ ok: true, message: "unreachable" }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/resume",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ provider: "codex" }),
		});
		assert.equal(response.statusCode, 400);
		assert.equal((await response.json()).ok, false);
	});
});
test("session launch endpoint invokes callback and forwards fields", async () => {
	await withServer({
		onSessionLaunch: async (payload) => ({
			ok: true,
			message: `launch:${payload.hubOnly}:${payload.cwd}:${payload.prompt}:${payload.model}:${payload.provider}:${payload.sessionDir}`,
			argv: ["--cwd", payload.cwd || "", "--", payload.prompt || ""],
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/launch",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cwd: "C:\\dev\\repo",
				prompt: "hello world",
				model: "gpt-5",
				provider: "openai",
				sessionDir: "C:\\dev\\sessions",
			}),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "launch:undefined:C:\\dev\\repo:hello world:gpt-5:openai:C:\\dev\\sessions");
		assert.deepEqual(body.argv, ["--cwd", "C:\\dev\\repo", "--", "hello world"]);
	});
});

test("session launch endpoint invokes callback and forwards targetNode", async () => {
	await withServer({
		onSessionLaunch: async (payload) => ({
			ok: true,
			message: `targetNode=${payload.targetNode}`,
			argv: ["colab"],
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/launch",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cwd: "C:\\dev\\repo",
				targetNode: "colab",
			}),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "targetNode=colab");
		assert.deepEqual(body.argv, ["colab"]);
	});
});

test("session launch endpoint rejects wrong-typed targetNode", async () => {
	await withServer({
		onSessionLaunch: async () => ({ ok: true, message: "unreachable" }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/launch",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ targetNode: 42 }),
		});
		assert.equal(response.statusCode, 400);
		const body = await response.json();
		assert.equal(body.ok, false);
		assert.match(body.error, /targetNode must be a string/);
	});
});
test("session launch endpoint forwards hubOnly true to the callback", async () => {
	await withServer({
		onSessionLaunch: async (payload) => ({
			ok: true,
			message: `hubOnly=${payload.hubOnly}`,
			argv: ["bg"],
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/launch",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ cwd: "C:\\dev\\fork", hubOnly: true }),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "hubOnly=true");
		assert.deepEqual(body.argv, ["bg"]);
	});
});

test("session launch endpoint rejects wrong-typed hubOnly", async () => {
	await withServer({
		onSessionLaunch: async () => ({ ok: true, message: "unreachable" }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/launch",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ hubOnly: "true" }),
		});
		assert.equal(response.statusCode, 400);
		const body = await response.json();
		assert.equal(body.ok, false);
		assert.match(body.error, /hubOnly must be a boolean/);
	});
});

test("session launch endpoint rejects wrong-typed model", async () => {
	await withServer({
		onSessionLaunch: async () => ({ ok: true, message: "unreachable" }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/launch",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: 42 }),
		});
		assert.equal(response.statusCode, 400);
		const body = await response.json();
		assert.equal(body.ok, false);
		assert.match(body.error, /model must be a string/);
	});
});

test("session launch endpoint returns 501 when callback is missing", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/launch",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ hubOnly: true }),
		});
		assert.equal(response.statusCode, 501);
		const body = await response.json();
		assert.equal(body.ok, false);
	});
});

test("session archive endpoint forwards path and action to callback", async () => {
	await withServer({
		onSessionArchive: async (payload) => ({ ok: true, message: `${payload.action}:${payload.sessionPath}` }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/archive",
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionPath: "C:\\s\\lane.jsonl", action: "recover" }),
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "recover:C:\\s\\lane.jsonl");
	});
});

test("session archive endpoint defaults action to archive and requires sessionPath", async () => {
	await withServer({
		onSessionArchive: async (payload) => ({ ok: true, message: `${payload.action}` }),
	}, async (port) => {
		const defaulted = await request({
			port,
			path: "/v1/sessions/archive",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: "C:\\s\\lane.jsonl" }),
		});
		assert.equal(defaulted.statusCode, 200);
		assert.equal((await defaulted.json()).message, "archive");

		const missing = await request({
			port,
			path: "/v1/sessions/archive",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
			body: JSON.stringify({ action: "archive" }),
		});
		assert.equal(missing.statusCode, 400);
		assert.match((await missing.json()).error, /sessionPath is required/);
	});
});

test("session archive endpoint returns 501 when callback is missing", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/v1/sessions/archive",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: "C:\\s\\lane.jsonl", action: "archive" }),
		});
		assert.equal(response.statusCode, 501);
		assert.equal((await response.json()).ok, false);
	});
});

test("agents endpoint returns discovered agents when callback is provided", async () => {
	await withServer({
		getDiscoveredAgents: () => ["codex:1234/project"],
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/agents",
			method: "GET",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.deepEqual(body.agents, ["codex:1234/project"]);
		assert.deepEqual(body.running, []);
		assert.deepEqual(body.recent, []);
	});
});

test("agents endpoint returns structured running agents and recent session paths", async () => {
	await withServer({
		getDiscoveredAgents: () => ({
			generatedAt: "2026-06-01T12:00:00.000Z",
			targets: ["codex:1234 pi-speak-extension"],
			running: [{
				provider: "codex",
				pid: 1234,
				target: "codex:1234 pi-speak-extension",
				cwd: "C:\\dev\\Desktop-Projects\\pi-speak-extension",
				cwdBasename: "pi-speak-extension",
				source: "process",
			}],
			recent: [{
				provider: "codex",
				path: "C:\\Users\\example\\.codex\\sessions\\2026\\06\\01\\session.jsonl",
				sessionId: "abc123",
				title: "Recent session",
				updatedAt: "2026-06-01T11:59:00.000Z",
				sourceHint: "sm",
			}],
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/agents",
			method: "GET",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.generatedAt, "2026-06-01T12:00:00.000Z");
		assert.deepEqual(body.agents, ["codex:1234 pi-speak-extension"]);
		assert.equal(body.running[0].cwdBasename, "pi-speak-extension");
		assert.equal(body.recent[0].sessionId, "abc123");
	});
});

test("discovery descriptor advertises Herdr control endpoints", async () => {
	await withServer({}, async (port) => {
		const response = await request({
			port,
			path: "/.well-known/pi-speak",
			headers: { Host: "tailnet.example" },
		});
		assert.equal(response.statusCode, 200);
		const descriptor = response.json();
		assert.equal(descriptor.endpoints.herdr, "/v1/herdr");
		assert.equal(descriptor.endpoints.herdrPaneRead, "/v1/herdr/pane/read");
		assert.equal(descriptor.endpoints.herdrPaneSend, "/v1/herdr/pane/send");
		assert.equal(descriptor.endpoints.herdrAgentSend, "/v1/herdr/agent/send");
		assert.ok(descriptor.capabilities.includes("herdr-control"));
	});
});

test("Herdr snapshot endpoint returns workspaces panes and agents", async () => {
	await withServer({
		getHerdrSnapshot: () => ({
			available: true,
			executable: "herdr",
			workspaces: [{ id: "w1", label: "pi-speak" }],
			panes: [{ pane_id: "w1:p1", label: "agent" }],
			agents: [{ pane_id: "w1:p1", state: "working" }],
		}),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/herdr",
			method: "GET",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const body = response.json();
		assert.equal(body.ok, true);
		assert.equal(body.herdr.available, true);
		assert.equal(body.herdr.workspaces[0].label, "pi-speak");
		assert.equal(body.herdr.panes[0].pane_id, "w1:p1");
		assert.equal(body.herdr.agents[0].state, "working");
	});
});

test("Herdr pane read endpoint forwards pane id and line count", async () => {
	await withServer({
		readHerdrPane: (paneId, lines) => ({ ok: true, message: `read:${paneId}:${lines}`, paneId, text: "recent output" }),
	}, async (port) => {
		const response = await request({
			port,
			path: "/v1/herdr/pane/read?paneId=w1%3Ap2&lines=25",
			method: "GET",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(response.statusCode, 200);
		const body = response.json();
		assert.equal(body.ok, true);
		assert.equal(body.message, "read:w1:p2:25");
		assert.equal(body.text, "recent output");
	});
});

test("Herdr send endpoints forward pane and agent payloads", async () => {
	const seen = [];
	await withServer({
		sendHerdrPane: (payload) => {
			seen.push({ kind: "pane", payload });
			return { ok: true, message: "pane sent" };
		},
		sendHerdrAgent: (payload) => {
			seen.push({ kind: "agent", payload });
			return { ok: true, message: "agent sent" };
		},
	}, async (port) => {
		const pane = await request({
			port,
			path: "/v1/herdr/pane/send",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
			body: JSON.stringify({ paneId: "w1:p2", text: "npm test", submit: true }),
		});
		assert.equal(pane.statusCode, 200);
		assert.equal(pane.json().message, "pane sent");

		const agent = await request({
			port,
			path: "/v1/herdr/agent/send",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: "w1:p2", text: "continue" }),
		});
		assert.equal(agent.statusCode, 200);
		assert.equal(agent.json().message, "agent sent");
	});
	assert.deepEqual(seen, [
		{ kind: "pane", payload: { paneId: "w1:p2", text: "npm test", submit: true } },
		{ kind: "agent", payload: { agentId: "w1:p2", text: "continue" } },
	]);
});

test("event stream endpoint returns SSE headers and initial data", async () => {
	await withServer({
		tailSessionEvents: (sinceOffset = 0) => ({
			events: sinceOffset === 0 ? [{ ts: 1, kind: "test", source: "admin", payload: {} }] : [],
			nextOffset: 1,
		}),
	}, async (port) => {
		const result = await new Promise((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port, path: "/v1/events", method: "GET", headers: { Authorization: "Bearer secret-token" } }, (res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					data += chunk;
					if (data.includes("data:")) {
						req.destroy();
						resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
					}
				});
				res.on("error", reject);
			});
			req.on("error", reject);
			req.setTimeout(3000, () => {
				req.destroy();
				reject(new Error("SSE test timeout"));
			});
			req.end();
		});
		assert.equal(result.statusCode, 200);
		assert.equal(result.headers["content-type"], "text/event-stream");
		assert.ok(result.body.includes("data:"));
	});
});

test("event stream endpoint accepts query token for browser EventSource clients", async () => {
	await withServer({
		tailSessionEvents: (sinceOffset = 0) => ({
			events: sinceOffset === 0 ? [{ ts: 1, kind: "test", source: "admin", payload: {} }] : [],
			nextOffset: 1,
		}),
	}, async (port) => {
		const result = await new Promise((resolve, reject) => {
			const req = http.request({
				host: "127.0.0.1",
				port,
				path: "/v1/events?token=secret-token",
				method: "GET",
				headers: { Host: "phone.example" },
			}, (res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					data += chunk;
					if (data.includes("data:")) {
						req.destroy();
						resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
					}
				});
				res.on("error", reject);
			});
			req.on("error", reject);
			req.setTimeout(3000, () => {
				req.destroy();
				reject(new Error("SSE query-token test timeout"));
			});
			req.end();
		});
		assert.equal(result.statusCode, 200);
		assert.match(result.headers["content-type"], /text\/event-stream/);
		assert.match(result.body, /data:/);
	});
});

test("workspace APIs list directories, read files, and guard the root", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-ws-"));
	const subDir = join(tempDir, "sub");
	mkdirSync(subDir);

	const textPath = join(tempDir, "hello.txt");
	const textContent = "Hello, Pi Speak workspace!\nLine two with unicode: café.";
	writeFileSync(textPath, textContent, "utf8");

	const binaryPath = join(tempDir, "blob.bin");
	writeFileSync(binaryPath, Buffer.from([0x68, 0x69, 0x00, 0x42, 0xff]));

	const largePath = join(tempDir, "big.txt");
	writeFileSync(largePath, "a".repeat(600 * 1024), "utf8");

	const authHeaders = { "X-Pi-Speak-Token": "secret-token" };

	try {
		await withTemporaryEnv("PI_SPEAK_WORKSPACE_ROOT", tempDir, async () => withServer({}, async (port) => {
			const listing = await request({
				port,
				path: `/v1/workspace?path=${encodeURIComponent(tempDir)}`,
				headers: authHeaders,
			});
			assert.equal(listing.statusCode, 200);
			const listingPayload = listing.json();
			assert.equal(listingPayload.ok, true);
			assert.equal(listingPayload.workspace.current, tempDir);
			assert.equal(listingPayload.workspace.truncated, false);

			const entries = listingPayload.workspace.entries;
			const dirEntry = entries.find((entry) => entry.name === "sub");
			assert.ok(dirEntry, "expected the sub directory entry");
			assert.equal(dirEntry.type, "directory");

			const helloEntry = entries.find((entry) => entry.name === "hello.txt");
			assert.ok(helloEntry, "expected the hello.txt entry");
			assert.equal(helloEntry.type, "file");
			assert.equal(typeof helloEntry.size, "number");

			// Directories sort before files.
			const dirIndex = entries.findIndex((entry) => entry.name === "sub");
			const fileIndices = entries
				.filter((entry) => entry.type === "file")
				.map((entry) => entries.indexOf(entry));
			for (const fileIndex of fileIndices) {
				assert.ok(dirIndex < fileIndex, "expected the directory to sort before files");
			}

			const textFile = await request({
				port,
				path: `/v1/workspace/file?path=${encodeURIComponent(textPath)}`,
				headers: authHeaders,
			});
			assert.equal(textFile.statusCode, 200);
			const textPayload = textFile.json();
			assert.equal(textPayload.ok, true);
			assert.equal(textPayload.file.binary, false);
			assert.equal(textPayload.file.truncated, false);
			assert.equal(textPayload.file.content, textContent);

			const binaryFile = await request({
				port,
				path: `/v1/workspace/file?path=${encodeURIComponent(binaryPath)}`,
				headers: authHeaders,
			});
			assert.equal(binaryFile.statusCode, 200);
			const binaryPayload = binaryFile.json();
			assert.equal(binaryPayload.ok, true);
			assert.equal(binaryPayload.file.binary, true);
			assert.equal(binaryPayload.file.content, "");

			const largeFile = await request({
				port,
				path: `/v1/workspace/file?path=${encodeURIComponent(largePath)}`,
				headers: authHeaders,
			});
			assert.equal(largeFile.statusCode, 200);
			const largePayload = largeFile.json();
			assert.equal(largePayload.ok, true);
			assert.equal(largePayload.file.truncated, true);
			assert.equal(largePayload.file.content.length, 512 * 1024);

			const traversalPath = join(tempDir, "..", "escape.txt");
			const traversal = await request({
				port,
				path: `/v1/workspace/file?path=${encodeURIComponent(traversalPath)}`,
				headers: authHeaders,
			});
			assert.equal(traversal.statusCode, 403);
			assert.equal(traversal.json().ok, false);

			const missingPath = await request({
				port,
				path: "/v1/workspace/file",
				headers: authHeaders,
			});
			assert.equal(missingPath.statusCode, 400);
		}));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("default workspace root is confined to the platform default workspace", async () => {
	const authHeaders = { "X-Pi-Speak-Token": "secret-token" };
	const expectedDefaultPath = process.platform === "win32" ? "C:\\Dev" : process.cwd();
	// Unset every override so getDefaultWorkspacePath() uses the platform default,
	// proving the default root is a bounded workspace rather than the filesystem/drive root.
	await withTemporaryEnv("PI_SPEAK_WORKSPACE_ROOT", undefined, async () =>
		withTemporaryEnv("AGENT_CWD", undefined, async () =>
			withTemporaryEnv("AGENT_WORKSPACE", undefined, async () =>
				withServer({}, async (port) => {
					const listing = await request({
						port,
						path: "/v1/workspace",
						headers: authHeaders,
					});
					assert.equal(listing.statusCode, 200);
					const payload = listing.json();
					assert.equal(payload.ok, true);
					assert.equal(payload.workspace.root, payload.workspace.defaultPath);
					assert.equal(payload.workspace.root, expectedDefaultPath);

					// A file outside the default workspace root must not be readable through the
					// authenticated file API; the confinement returns 403, not the file body.
					const outsideDir = mkdtempSync(join(tmpdir(), "pi-speak-outside-"));
					const outsidePath = join(outsideDir, "secret.txt");
					try {
						writeFileSync(outsidePath, "top secret", "utf8");
						const blocked = await request({
							port,
							path: `/v1/workspace/file?path=${encodeURIComponent(outsidePath)}`,
							headers: authHeaders,
						});
						assert.equal(blocked.statusCode, 403);
						assert.equal(blocked.json().ok, false);
					} finally {
						rmSync(outsideDir, { recursive: true, force: true });
					}
				})
			)
		)
	);
});

test("collab link endpoint reports the active link written to collab.json", async () => {
	const authHeaders = { Authorization: "Bearer secret-token" };
	const configDir = mkdtempSync(join(tmpdir(), "pi-speak-collab-"));
	try {
		writeFileSync(
			join(configDir, "collab.json"),
			JSON.stringify({
				active: true,
				webLink: "https://x/#w",
				webViewLink: "https://x/#v",
				link: "https://x/#w",
				viewLink: "https://x/#v",
				view: false,
				startedAt: "2026-06-27T00:00:00.000Z",
			}),
			"utf8",
		);
		await withTemporaryEnv("PI_SPEAK_CONFIG_DIR", configDir, async () => withServer({}, async (port) => {
			const response = await request({
				port,
				path: "/v1/collab-link",
				headers: authHeaders,
			});
			assert.equal(response.statusCode, 200);
			const payload = response.json();
			assert.equal(payload.ok, true);
			assert.equal(payload.collab.active, true);
			assert.equal(payload.collab.webLink, "https://x/#w");
			assert.equal(payload.collab.webViewLink, "https://x/#v");
			assert.equal(payload.collab.view, false);
			assert.equal(payload.collab.startedAt, "2026-06-27T00:00:00.000Z");
		}));
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
});

test("collab link endpoint reports inactive when collab.json is absent", async () => {
	const authHeaders = { Authorization: "Bearer secret-token" };
	const configDir = mkdtempSync(join(tmpdir(), "pi-speak-collab-empty-"));
	try {
		await withTemporaryEnv("PI_SPEAK_CONFIG_DIR", configDir, async () => withServer({}, async (port) => {
			const response = await request({
				port,
				path: "/v1/collab-link",
				headers: authHeaders,
			});
			assert.equal(response.statusCode, 200);
			const payload = response.json();
			assert.equal(payload.ok, true);
			assert.equal(payload.collab.active, false);
			assert.equal(payload.collab.webLink, undefined);
		}));
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
});

test("workspace file API rejects Windows reserved device names", async () => {
	// Reserved device names (CON, NUL, COM1, ...) only resolve to devices on Windows;
	// on other platforms this guard is a no-op so the suite stays green on Linux CI.
	if (process.platform !== "win32") return;
	const authHeaders = { "X-Pi-Speak-Token": "secret-token" };
	const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-reserved-"));
	try {
		await withTemporaryEnv("PI_SPEAK_WORKSPACE_ROOT", tempDir, async () => withServer({}, async (port) => {
			const response = await request({
				port,
				path: `/v1/workspace/file?path=${encodeURIComponent(join(tempDir, "NUL"))}`,
				headers: authHeaders,
			});
			assert.equal(response.statusCode, 400);
			assert.equal(response.json().ok, false);
		}));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("ompk select/selected endpoints isolate selections per client and support legacy path aliases", async () => {
	const { OmpSelectionStore } = await import("../dist/omp-selection.js");
	const store = new OmpSelectionStore();
	await withServer({
		onOmpSelectSession: (clientKey, sessionPath) => store.select(clientKey, sessionPath),
		onOmpGetSelectedSession: (clientKey) => store.get(clientKey),
	}, async (port) => {
		const select = (client, sessionPath) => request({
			port,
			path: "/v1/ompk/select-session",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json", "x-pi-speak-client": client },
			body: JSON.stringify(sessionPath === null ? { clear: true } : { sessionPath }),
		});
		const selected = (client) => request({
			port,
			path: "/v1/ompk/selected-session",
			headers: { Authorization: "Bearer secret-token", "x-pi-speak-client": client },
		});

		// Client A selects; client B must NOT see it (C1).
		await select("A", "/omp/a.jsonl");
		assert.equal((await (await selected("A")).json()).sessionPath, "/omp/a.jsonl");
		assert.equal((await (await selected("B")).json()).sessionPath, null);

		// Client B selects its own.
		await select("B", "/omp/b.jsonl");
		assert.equal((await (await selected("A")).json()).sessionPath, "/omp/a.jsonl");
		assert.equal((await (await selected("B")).json()).sessionPath, "/omp/b.jsonl");

		// Client A deselects (C2) — B unaffected.
		const clearRes = await (await select("A", null)).json();
		assert.equal(clearRes.cleared, true);
		assert.equal((await (await selected("A")).json()).sessionPath, null);
		assert.equal((await (await selected("B")).json()).sessionPath, "/omp/b.jsonl");
		const legacySelected = await request({
			port,
			path: "/v1/omp/selected-session",
			headers: { Authorization: "Bearer secret-token", "x-pi-speak-client": "B" },
		});
		assert.equal((await legacySelected.json()).sessionPath, "/omp/b.jsonl");
	});
});

test("ompk select-session surfaces validation failure as 400 (review H2)", async () => {
	await withServer({
		onOmpSelectSession: (_clientKey, sessionPath) => {
			if (sessionPath && !sessionPath.startsWith("/valid/")) {
				return { ok: false, error: "Session file does not exist." };
			}
			return { ok: true };
		},
	}, async (port) => {
		const bad = await request({
			port,
			path: "/v1/ompk/select-session",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json", "x-pi-speak-client": "c" },
			body: JSON.stringify({ sessionPath: "/stale/gone.jsonl" }),
		});
		assert.equal(bad.statusCode, 400);
		assert.match((await bad.json()).error, /does not exist/);

		const good = await request({
			port,
			path: "/v1/ompk/select-session",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json", "x-pi-speak-client": "c" },
			body: JSON.stringify({ sessionPath: "/valid/ok.jsonl" }),
		});
		assert.equal(good.statusCode, 200);
		assert.equal((await good.json()).ok, true);

		// Deselect must never be rejected by validation.
		const clear = await request({
			port,
			path: "/v1/ompk/select-session",
			method: "POST",
			headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json", "x-pi-speak-client": "c" },
			body: JSON.stringify({ clear: true }),
		});
		assert.equal(clear.statusCode, 200);
		assert.equal((await clear.json()).cleared, true);
	});
});

function firstExternalIpv4() {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries || []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

test("GET /connect serves the pairing page on loopback without a token", async () => {
	await withServer({}, async (port) => {
		const response = await request({ port, path: "/connect" });
		assert.equal(response.statusCode, 200);
		assert.match(response.headers["content-type"], /text\/html/);
		assert.ok(response.body.includes("Connect your phone"));
		// The no-camera fallback link must carry the auth token for one-scan setup.
		assert.ok(response.body.includes("token=secret-token"));
		// Live status wiring polls the pairing endpoint.
		assert.ok(response.body.includes("/v1/pairing/status"));
	});
});

test("GET /v1/pairing/status stays null for loopback-only traffic", async () => {
	await withServer({}, async (port) => {
		// Loopback authed traffic must NOT count as a phone connection.
		const status = await request({ port, path: "/v1/status", headers: { "X-Pi-Speak-Token": "secret-token" } });
		assert.equal(status.statusCode, 200);
		const pairing = await request({ port, path: "/v1/pairing/status" });
		assert.equal(pairing.statusCode, 200);
		const payload = pairing.json();
		assert.equal(payload.ok, true);
		assert.equal(payload.lastRemoteClient, null);
		assert.equal(payload.gateway.authRequired, true);
	});
});

test("non-loopback clients cannot read /connect but do mark pairing activity", async (t) => {
	const externalIp = firstExternalIpv4();
	if (!externalIp) {
		t.skip("no non-internal IPv4 interface available");
		return;
	}
	await withServer({ state: { host: "0.0.0.0" } }, async (port) => {
		// The connect page (it embeds the token QR) must be refused off-loopback.
		const connect = await request({ port, host: externalIp, path: "/connect" });
		assert.equal(connect.statusCode, 403);

		// Pairing status polls from remote must not self-record...
		const poll = await request({ port, host: externalIp, path: "/v1/pairing/status", headers: { "X-Pi-Speak-Token": "secret-token" } });
		assert.equal(poll.statusCode, 200);
		let pairing = (await request({ port, path: "/v1/pairing/status" })).json();
		assert.equal(pairing.lastRemoteClient, null);

		// ...but a real authed call (what the app does at setup) must.
		const before = Date.now();
		const status = await request({ port, host: externalIp, path: "/v1/status", headers: { "X-Pi-Speak-Token": "secret-token" } });
		assert.equal(status.statusCode, 200);
		pairing = (await request({ port, path: "/v1/pairing/status" })).json();
		assert.ok(pairing.lastRemoteClient, "expected lastRemoteClient to be recorded");
		assert.ok(pairing.lastRemoteClient.at >= before);
		assert.equal(pairing.lastRemoteClient.address, externalIp);
	});
});
