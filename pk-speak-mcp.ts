#!/usr/bin/env node
// Thin stdio MCP adapter for the pk-speak CLI.
//
// Design: this server does NOT reimplement TTS in-process. It SHELLS OUT to
// the existing pk-speak CLI (dist/pk-speak.js), because the CLI already handles
// voice-before-import env ordering, the offline sanitizer, temp-file cleanup,
// and cross-platform playback. A per-call voice override only works by spawning
// a fresh CLI process, so each "speak" invocation spawns its own pk-speak run.
//
// CRITICAL: nothing here may write to STDOUT except the JSON-RPC stream that
// StdioServerTransport owns. All diagnostics go to console.error (STDERR).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// pk-speak.js is compiled as a sibling of this module (both land in dist/).
const here = dirname(fileURLToPath(import.meta.url));
const PK_SPEAK_CLI = join(here, "pk-speak.js");

function runPkSpeak(text: string, voice?: string): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const args = [PK_SPEAK_CLI, ...(voice ? ["--voice", voice] : []), text];
		// Inherit stdin/stdout is unnecessary; we only care about exit code and
		// stderr. The child's stdout (if any) is ignored so it can never leak
		// into our JSON-RPC stream.
		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stderr });
		});
	});
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

const server = new McpServer({
	name: "pk-speak",
	version: "0.1.0",
});

server.registerTool(
	"speak",
	{
		description:
			"Speak text aloud using the configured pi-speak TTS provider. Pass one or two natural, spoken-style sentences. Optionally override the voice.",
		inputSchema: {
			text: z.string().describe("The text to speak aloud, in plain spoken English."),
			voice: z
				.string()
				.optional()
				.describe("Optional voice name to override the active provider's default voice."),
		},
	},
	async ({ text, voice }) => {
		try {
			const { code, stderr } = await runPkSpeak(text, voice);
			if (code !== 0) {
				const detail = stderr.trim() || `pk-speak exited with code ${code}`;
				return {
					content: [{ type: "text", text: detail }],
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: "Spoke." }],
			};
		} catch (error) {
			return {
				content: [{ type: "text", text: `Failed to run pk-speak: ${getErrorMessage(error)}` }],
				isError: true,
			};
		}
	},
);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("pk-speak MCP server running on stdio.");
}

main().catch((error) => {
	console.error(`pk-speak MCP server fatal error: ${getErrorMessage(error)}`);
	process.exit(1);
});
