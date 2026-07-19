import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const { buildAgentSpeakCommand, buildAgentSpeechPreamble, resolveBundledPkSpeakCli } = await import("../dist/agent-speech.js");

test("agent mode resolves the packaged dispatcher instead of an undeclared global command", () => {
	const extensionRoot = join(process.cwd(), "fixture-pi-pk-speak");
	const cliPath = join(extensionRoot, "dist", "pk-speak.js");
	const command = buildAgentSpeakCommand(extensionRoot, "/usr/local/bin/node", (path) => path === cliPath, "linux");

	assert.equal(resolveBundledPkSpeakCli(extensionRoot, (path) => path === cliPath), cliPath);
	assert.equal(command, `'/usr/local/bin/node' '${cliPath}' speak`);
	assert.doesNotMatch(command, /^pk-speak\b/);
	assert.match(buildAgentSpeechPreamble(command), /pk-speak\.js' speak/);
	const windowsRoot = "C:\\Pi Speak";
	const windowsCommand = buildAgentSpeakCommand(windowsRoot, "C:\\Program Files\\nodejs\\node.exe", () => true, "win32");
	assert.equal(windowsCommand, `"C:\\Program Files\\nodejs\\node.exe" "${join(windowsRoot, "dist", "pk-speak.js")}" speak`);
});

test("pi-pk-speak publishes its dispatcher and MCP server in the package payload", async () => {
	const manifest = JSON.parse(await readFile("packages/pi-pk-speak/package.json", "utf8"));
	assert.equal(manifest.files.includes("!dist/pk-speak.*"), false);
	assert.equal(manifest.bin["pi-speak-mcp"], "dist/pk-speak-mcp.js");
	assert.equal(manifest.dependencies["@modelcontextprotocol/sdk"], "^1.29.0");
});
