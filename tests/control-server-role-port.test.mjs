import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { ControlServer } = await import("../dist/control-server.js");

function getJson(port, path) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { data += chunk; });
			res.on("end", () => {
				try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
			});
		});
		req.on("error", reject);
		req.end();
	});
}

function freePort() {
	return new Promise((resolve, reject) => {
		const probe = http.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

function occupy(port) {
	return new Promise((resolve, reject) => {
		const blocker = http.createServer();
		blocker.once("error", reject);
		blocker.listen(port, "127.0.0.1", () => resolve(blocker));
	});
}

function closeServer(server) {
	return new Promise((resolve) => server.close(() => resolve()));
}

function makeServer(stateOverrides = {}, optionOverrides = {}) {
	return new ControlServer({
		state: {
			enabled: false,
			host: "127.0.0.1",
			port: 0,
			authToken: "secret-token",
			...stateOverrides,
		},
		onStateChange: () => {},
		getStatus: () => ({
			speak: { enabled: false },
			mono: { running: false },
			phone: { enabled: false },
			remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true },
		}),
		getDiagnostics: () => ({
			status: {
				speak: { enabled: false },
				mono: { running: false },
				phone: { enabled: false },
				remote: { enabled: true, host: "127.0.0.1", port: 0, authRequired: true },
			},
		}),
		getRoutingStatus: () => ({ availableTargets: ["pi"] }),
		setRoutingTarget: async () => ({ ok: true, message: "target" }),
		onMonoAction: async () => ({ ok: true, message: "mono" }),
		onSpeakAction: async () => ({ ok: true, message: "speak" }),
		onPhoneAction: async () => ({ ok: true, message: "phone" }),
		onTextTurn: async (text) => ({ replyText: text }),
		...optionOverrides,
	});
}

test("/health advertises the server role so probes can distinguish gateway from session servers", async () => {
	const gateway = makeServer();
	const gatewayRuntime = await gateway.start();
	try {
		const health = await getJson(gatewayRuntime.port, "/health");
		assert.equal(health.app, "pi-speak");
		assert.equal(health.role, "gateway");
	} finally {
		await gateway.stop();
	}

	const session = makeServer({ role: "session" });
	const sessionRuntime = await session.start();
	try {
		const health = await getJson(sessionRuntime.port, "/health");
		assert.equal(health.app, "pi-speak");
		assert.equal(health.role, "session");
	} finally {
		await session.stop();
	}
});

test("portRetries binds the next free port when the base port is occupied", async () => {
	const basePort = await freePort();
	const blocker = await occupy(basePort);
	try {
		const server = makeServer({ port: basePort }, { portRetries: 5 });
		const runtime = await server.start();
		try {
			assert.ok(runtime.port > basePort && runtime.port <= basePort + 5);
			const health = await getJson(runtime.port, "/health");
			assert.equal(health.ok, true);
		} finally {
			await server.stop();
		}
	} finally {
		await closeServer(blocker);
	}
});

test("without portRetries an occupied port rejects so the gateway never silently roams", async () => {
	const basePort = await freePort();
	const blocker = await occupy(basePort);
	try {
		const server = makeServer({ port: basePort });
		await assert.rejects(() => server.start(), (error) => error && error.code === "EADDRINUSE");
	} finally {
		await closeServer(blocker);
	}
});
