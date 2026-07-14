import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { ControlServer } from "../dist/control-server.js";
import { classifyRealtimeTerminalCommand, buildRealtimeTools, REALTIME_SYSTEM_PROMPT } from "../dist/realtime-gateway.js";
import {
	buildRealtimeTerminalCommandPlan,
	executeRealtimeTerminalCommandPlan,
} from "../dist/realtime-terminal-command.js";

test("REALTIME_SYSTEM_PROMPT frames a conversational assistant that reads freely but asks before mutating", () => {
	assert.doesNotMatch(REALTIME_SYSTEM_PROMPT, /voice coding assistant/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /conversational assistant/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /read-only tools/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /require.*(the )?operator's explicit approval/i);
	assert.match(REALTIME_SYSTEM_PROMPT, /clarifying question/i);
});

test("buildRealtimeTools exposes read-only agent-hub and workspace tools alongside the existing session tools", () => {
	const [{ functionDeclarations }] = buildRealtimeTools(false);
	const names = functionDeclarations.map((tool) => tool.name);

	for (const readOnlyName of [
		"get_session_info",
		"list_sessions",
		"list_agent_hub_agents",
		"get_agent_hub_agent",
		"browse_workspace",
		"read_workspace_file",
	]) {
		assert.ok(names.includes(readOnlyName), `expected read-only tool ${readOnlyName}`);
	}

	for (const mutatingName of ["launch_agent", "archive_session"]) {
		const tool = functionDeclarations.find((t) => t.name === mutatingName);
		assert.ok(tool, `expected mutating tool ${mutatingName}`);
		assert.match(tool.description, /requires operator approval/i);
	}
});

test("buildRealtimeTools only sets NON_BLOCKING behavior when the caller opts in", () => {
	const [{ functionDeclarations: blocking }] = buildRealtimeTools(false);
	for (const tool of blocking) assert.equal(tool.behavior, undefined, tool.name);

	const [{ functionDeclarations: nonBlocking }] = buildRealtimeTools(true);
	const terminalTool = nonBlocking.find((t) => t.name === "execute_terminal_command");
	const launchTool = nonBlocking.find((t) => t.name === "launch_agent");
	assert.equal(terminalTool.behavior, "NON_BLOCKING");
	assert.equal(launchTool.behavior, "NON_BLOCKING");
});

const TEST_PORT = 18768;
const TEST_TOKEN = "test-secret-token";

test("realtime terminal safety allows only read-only commands", () => {
	for (const command of [
		"git status",
		"git status --short",
		"npm test",
		"npm run build",
		"rg execute_terminal_command realtime-gateway.ts",
		"Get-Content package.json",
	]) {
		assert.deepEqual(
			classifyRealtimeTerminalCommand(command),
			{ action: "allow", reason: "read-only-allowlist" },
			command,
		);
	}
});

test("realtime terminal safety requires confirmation for risky or unknown commands", () => {
	const cases = [
		["npm install", "mutating-command"],
		["git commit -m test", "mutating-command"],
		["Remove-Item dist -Recurse", "mutating-command"],
		["rg TODO > todo.txt", "shell-control-operator"],
		["git status && npm install", "shell-control-operator"],
		["git status\nnpm install", "shell-control-operator"],
		["node scripts/write-file.js", "not-on-read-only-allowlist"],
		["rg API_KEY .", "secret-inspection"],
		["Get-Content .env", "secret-inspection"],
	];
	for (const [command, reason] of cases) {
		assert.deepEqual(
			classifyRealtimeTerminalCommand(command),
			{ action: "requires_confirmation", reason },
			command,
		);
	}
});

test("realtime terminal command registry creates argv plans without a shell", () => {
	const plan = buildRealtimeTerminalCommandPlan("git status --short");
	assert.equal(plan.action, "allow");
	assert.equal(plan.executableKnown, true);
	assert.equal(plan.executable, "git");
	assert.deepEqual(plan.args, ["status", "--short"]);

	const commitPlan = buildRealtimeTerminalCommandPlan('git commit -m "test message"');
	assert.equal(commitPlan.action, "requires_confirmation");
	assert.equal(commitPlan.reason, "mutating-command");
	assert.equal(commitPlan.executableKnown, true);
	assert.deepEqual(commitPlan.args, ["commit", "-m", "test message"]);

	const unknownPlan = buildRealtimeTerminalCommandPlan("python write.py");
	assert.equal(unknownPlan.action, "requires_confirmation");
	assert.equal(unknownPlan.executableKnown, false);
});

test("realtime terminal command registry executes Get-Content internally", async () => {
	const plan = buildRealtimeTerminalCommandPlan("Get-Content package.json");
	assert.equal(plan.action, "allow");
	assert.equal(plan.internal, "get-content");

	const result = await executeRealtimeTerminalCommandPlan(plan, process.cwd());
	assert.equal(result.ok, true);
	assert.match(result.stdout, /"name": "pk-speak"/);
});

test("WebSocket realtime gateway authentication and routing", async (t) => {
	let connectionReceived = false;
	const server = new ControlServer({
		state: {
			enabled: false,
			host: "127.0.0.1",
			port: TEST_PORT,
			authToken: TEST_TOKEN,
		},
		onStateChange: () => {},
		getStatus: () => ({}),
		getDiagnostics: () => ({}),
		getRoutingStatus: () => ({}),
		setRoutingTarget: () => ({ ok: true, message: "ok" }),
		onMonoAction: () => ({ ok: true, message: "ok" }),
		onSpeakAction: () => ({ ok: true, message: "ok" }),
		onPhoneAction: () => ({ ok: true, message: "ok" }),
		onTextTurn: async () => ({ replyText: "hello" }),
		onVoiceTurn: async () => ({ replyText: "hello" }),
		onRealtimeConnection: (ws) => {
			connectionReceived = true;
			ws.on("message", (msg) => {
				ws.send("echo:" + msg.toString());
			});
		},
	});

	await server.start();

	await t.test("rejects connection with invalid token", async () => {
		let connectionFailed = false;
		const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/live?token=wrong-token`, {
			headers: { Host: "tailnet.example" }
		});
		
		await new Promise((resolve) => {
			ws.on("error", () => {
				connectionFailed = true;
				resolve();
			});
			ws.on("open", () => {
				ws.close();
				resolve();
			});
		});

		assert.ok(connectionFailed, "Connection should be rejected (401)");
	});

	await t.test("accepts connection with valid token", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/live?token=${TEST_TOKEN}`, {
			headers: { Host: "tailnet.example" }
		});
		
		const opened = await new Promise((resolve) => {
			ws.on("open", () => {
				resolve(true);
			});
			ws.on("error", (err) => {
				resolve(false);
			});
		});

		assert.ok(opened, "WebSocket should connect successfully");
		assert.ok(connectionReceived, "onRealtimeConnection should be called");

		// Test basic message echo
		const replyPromise = new Promise((resolve) => {
			ws.on("message", (data) => {
				resolve(data.toString());
			});
		});

		ws.send("test-packet");
		const reply = await replyPromise;
		assert.equal(reply, "echo:test-packet");

		ws.close();
		await new Promise((resolve) => ws.on("close", resolve));
	});


	await t.test("exposes Warp and psmux status through authenticated API", async () => {
		const previousPsmuxBin = process.env.PI_SPEAK_PSMUX_BIN;
		const previousWarpOpenBin = process.env.PI_SPEAK_WARP_OPEN_BIN;
		process.env.PI_SPEAK_PSMUX_BIN = "__missing_psmux_for_test__";
		process.env.PI_SPEAK_WARP_OPEN_BIN = "__missing_warp_open_for_test__";
		try {

			const response = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/warp`, {
				headers: {
					Host: "tailnet.example",
					"X-Pi-Speak-Token": TEST_TOKEN,
				},
			});
			assert.equal(response.status, 200);
			const body = await response.json();
			assert.equal(body.ok, true);
			assert.equal(body.warp.psmux.available, false);
			assert.equal(body.warp.psmux.executable, "__missing_psmux_for_test__");
			assert.ok(typeof body.warp.psmux.error === "string");
			assert.equal(body.warp.warpUriScheme, "warp");

			const tabResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/warp/tab`, {
				method: "POST",
				headers: {
					Host: "tailnet.example",
					"X-Pi-Speak-Token": TEST_TOKEN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ cwd: process.cwd() }),
			});
			assert.equal(tabResponse.status, 400);
			const tabBody = await tabResponse.json();
			assert.equal(tabBody.ok, false);
			assert.match(tabBody.uri, /^warp:\/\/action\/new_tab\?path=/);
			assert.match(tabBody.message, /ENOENT|not found|no such file|Failed/i);

			const configResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/warp/tab-config`, {
				method: "POST",
				headers: {
					Host: "tailnet.example",
					"X-Pi-Speak-Token": TEST_TOKEN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: "phone_remote", newWindow: true }),
			});
			assert.equal(configResponse.status, 400);
			const configBody = await configResponse.json();
			assert.equal(configBody.ok, false);
			assert.equal(configBody.uri, "warp://tab_config/phone_remote?new_window=true");
		} finally {
			if (previousPsmuxBin === undefined) delete process.env.PI_SPEAK_PSMUX_BIN;
			else process.env.PI_SPEAK_PSMUX_BIN = previousPsmuxBin;
			if (previousWarpOpenBin === undefined) delete process.env.PI_SPEAK_WARP_OPEN_BIN;
			else process.env.PI_SPEAK_WARP_OPEN_BIN = previousWarpOpenBin;
		}
	});
	await server.stop();
});

test("get-content path traversal resolves to a structured error instead of throwing", async () => {
	// Regression for the unhandled-rejection fix: runInternalGetContent throws on a
	// path that escapes the workspace; executeRealtimeTerminalCommandPlan must catch
	// it and return { ok: false, ... } so the rejection can't crash the gateway.
	const plan = buildRealtimeTerminalCommandPlan("get-content ../../etc/passwd");
	assert.equal(plan.internal, "get-content");
	let result;
	await assert.doesNotReject(async () => {
		result = await executeRealtimeTerminalCommandPlan(plan, process.cwd());
	});
	assert.equal(result.ok, false);
	assert.match(result.stderr, /outside the active workspace/i);
});
