import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Use the OFFICIAL MCP SDK client to drive the server over real JSON-RPC/stdio.
// These subpaths must exist in the installed SDK; if they don't, importing this
// module throws at load time and the whole test file FAILS LOUDLY (never a
// silent skip). The installed version is @modelcontextprotocol/sdk@1.29.x, which
// exposes "./client/index.js" (Client) and "./client/stdio.js"
// (StdioClientTransport). If a future SDK bump moves these, this import error is
// the intended, visible failure signal.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Repo root is the parent of tests/. The compiled server lives at
// dist/pk-speak-mcp.js (tsconfig include is ["*.ts"] at root, so a root
// pk-speak-mcp.ts auto-compiles to dist/pk-speak-mcp.js).
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_ENTRY = join(REPO_ROOT, "dist", "pk-speak-mcp.js");

// Cap any single request so a misbehaving server cannot hang the runner.
const REQUEST_TIMEOUT_MS = 20_000;

// Connect a fresh client to the spawned server and return both so the caller
// can tear them down. stderr is piped (not inherited) so server diagnostics do
// not pollute the test runner output, and so a crash-on-start surfaces here
// rather than silently. We never invoke the speak tool, so this is fully
// hermetic: no audio, no network.
async function connectServerClient() {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_ENTRY],
		cwd: REPO_ROOT,
		// Inherit the parent env so the child resolves Node/PATH normally on
		// every platform. The server is a thin adapter that only shells out to
		// the pk-speak CLI when the speak tool is CALLED; listTools() touches no
		// audio/network path, so passing env is safe and keeps the test hermetic.
		env: Object.fromEntries(
			Object.entries(process.env).filter(([, value]) => typeof value === "string"),
		),
		stderr: "pipe",
	});

	const client = new Client(
		{ name: "pk-speak-mcp-test-client", version: "0.0.0" },
		{ capabilities: {} },
	);

	// connect() runs the MCP initialize handshake; if dist/pk-speak-mcp.js is
	// missing or crashes on boot, this rejects (loud failure) instead of hanging.
	await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
	return { client, transport };
}

// Close the client (which also closes the transport and kills the child
// process) so the runner exits cleanly. Swallow teardown errors so a flaky
// close never masks the real assertion result.
async function teardown(client, transport) {
	try {
		if (client) await client.close();
	} catch {
		// ignore
	}
	try {
		if (transport) await transport.close();
	} catch {
		// ignore
	}
}

test("MCP server exposes a 'speak' tool with required text + optional voice", async (t) => {
	// Precondition: the compiled server must exist. Fail with a precise,
	// actionable message instead of letting the stdio spawn produce an opaque
	// error or hang when the build is missing.
	assert.equal(
		existsSync(SERVER_ENTRY),
		true,
		`expected compiled MCP server at ${SERVER_ENTRY} (run \`npm run build\` so root pk-speak-mcp.ts compiles to dist/pk-speak-mcp.js)`,
	);

	const { client, transport } = await connectServerClient();
	// Hard safety net: even if a request stalls, kill the child at test end.
	t.after(() => teardown(client, transport));

	const result = await client.listTools({}, { timeout: REQUEST_TIMEOUT_MS });

	assert.ok(Array.isArray(result.tools), "listTools() must return a tools array");

	const speak = result.tools.find((tool) => tool.name === "speak");
	assert.ok(speak, `expected a tool named "speak"; got: ${JSON.stringify(result.tools.map((t2) => t2.name))}`);

	// The input schema must be a JSON-Schema object describing the speak params.
	const schema = speak.inputSchema;
	assert.ok(schema && typeof schema === "object", "speak.inputSchema must be an object");
	assert.equal(schema.type, "object", "speak.inputSchema.type must be 'object'");

	const properties = schema.properties ?? {};
	assert.ok(
		properties.text && typeof properties.text === "object",
		"speak schema must declare a 'text' property",
	);
	assert.equal(
		properties.text.type,
		"string",
		"speak 'text' property must be a string",
	);

	// text is REQUIRED.
	assert.ok(Array.isArray(schema.required), "speak schema must list required fields");
	assert.ok(
		schema.required.includes("text"),
		`speak 'text' must be required; required=${JSON.stringify(schema.required)}`,
	);

	// voice is OPTIONAL: present in properties, absent from required.
	assert.ok(
		properties.voice && typeof properties.voice === "object",
		"speak schema must declare an optional 'voice' property",
	);
	assert.equal(
		properties.voice.type,
		"string",
		"speak 'voice' property must be a string",
	);
	assert.equal(
		schema.required.includes("voice"),
		false,
		`speak 'voice' must be optional (not in required); required=${JSON.stringify(schema.required)}`,
	);
});
