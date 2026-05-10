#!/usr/bin/env node
import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_TIMEOUT_MS = 30000;

type SmokeResult = {
	ok: boolean;
	model: string;
	apiVersion: string;
	modality: "TEXT" | "AUDIO";
	text: string;
	audioChunks: number;
	setupComplete: boolean;
	turnComplete: boolean;
	closeCode?: number;
	closeReason?: string;
	error?: string;
	usageMetadata?: unknown;
};

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
	if (!apiKey) {
		throw new Error("Set GOOGLE_API_KEY before running the Gemini Live smoke test.");
	}
	const model = args.model || process.env.PI_SPEAK_GEMINI_LIVE_MODEL || DEFAULT_MODEL;
	const prompt = args.prompt || "Reply with exactly: gemini live ok";
	const modality = normalizeModality(args.modality || process.env.PI_SPEAK_GEMINI_LIVE_MODALITY || "audio");
	const timeoutMs = Number.parseInt(args.timeout || process.env.PI_SPEAK_GEMINI_LIVE_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
	const result = await runGeminiLiveSmoke({ apiKey, model, prompt, modality, timeoutMs });
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	if (!result.ok) process.exitCode = 1;
}

export async function runGeminiLiveSmoke(options: {
	apiKey: string;
	model: string;
	prompt: string;
	modality: "TEXT" | "AUDIO";
	timeoutMs?: number;
}): Promise<SmokeResult> {
	const apiVersion = process.env.PI_SPEAK_GEMINI_API_VERSION || "v1beta";
	const ai = new GoogleGenAI({
		apiKey: options.apiKey,
		apiVersion,
	});
	let setupComplete = false;
	let turnComplete = false;
	let usageMetadata: unknown;
	let text = "";
	let audioChunks = 0;
	let closeCode: number | undefined;
	let closeReason: string | undefined;
	let errorMessage: string | undefined;
	let session: Awaited<ReturnType<typeof ai.live.connect>> | undefined;
	const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

	return await new Promise<SmokeResult>((resolve, reject) => {
		let settled = false;
		const finish = (result: SmokeResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				session?.close();
			} catch {}
			resolve(result);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				session?.close();
			} catch {}
			reject(error);
		};
		const timer = setTimeout(() => {
			finish({
				ok: false,
				model: options.model,
				apiVersion,
				modality: options.modality,
				text,
				audioChunks,
				setupComplete,
				turnComplete,
				closeCode,
				closeReason,
				error: errorMessage,
				usageMetadata,
			});
		}, timeoutMs);

		ai.live.connect({
			model: options.model,
			config: {
				responseModalities: [options.modality === "AUDIO" ? Modality.AUDIO : Modality.TEXT],
				outputAudioTranscription: options.modality === "AUDIO" ? {} : undefined,
				systemInstruction: "You are a terse connectivity test endpoint.",
			},
			callbacks: {
				onopen: () => {},
				onmessage: (message: LiveServerMessage) => {
					if (message.setupComplete) setupComplete = true;
					if (message.usageMetadata) usageMetadata = message.usageMetadata;
					text += extractText(message);
					audioChunks += countAudioChunks(message);
					if (message.serverContent?.turnComplete) {
						turnComplete = true;
						finish({
							ok: setupComplete && (text.trim().length > 0 || audioChunks > 0),
							model: options.model,
							apiVersion,
							modality: options.modality,
							text: text.trim(),
							audioChunks,
							setupComplete,
							turnComplete,
							closeCode,
							closeReason,
							error: errorMessage,
							usageMetadata,
						});
					}
				},
				onerror: (event) => {
					errorMessage = getEventMessage(event);
					fail(event.error || event.message || event);
				},
				onclose: (event) => {
					closeCode = event.code;
					closeReason = event.reason;
					if (!settled) {
						finish({
							ok: setupComplete && (text.trim().length > 0 || audioChunks > 0),
							model: options.model,
							apiVersion,
							modality: options.modality,
							text: text.trim(),
							audioChunks,
							setupComplete,
							turnComplete,
							closeCode,
							closeReason,
							error: errorMessage,
							usageMetadata,
						});
					}
				},
			},
		}).then((connected) => {
			session = connected;
			session.sendClientContent({
				turns: [{ role: "user", parts: [{ text: options.prompt }] }],
				turnComplete: true,
			});
		}).catch(fail);
	});
}

function extractText(message: LiveServerMessage): string {
	const transcript = message.serverContent?.outputTranscription?.text;
	let text = typeof transcript === "string" ? transcript : "";
	const parts = message.serverContent?.modelTurn?.parts;
	if (!parts) return text;
	text += parts.map((part) => typeof part.text === "string" ? part.text : "").join("");
	return text;
}

function countAudioChunks(message: LiveServerMessage): number {
	const parts = message.serverContent?.modelTurn?.parts;
	if (!parts) return 0;
	return parts.filter((part) => !!part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")).length;
}

function parseArgs(args: string[]) {
	const parsed: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = args[index + 1];
		if (next && !next.startsWith("--")) {
			parsed[key] = next;
			index += 1;
		} else {
			parsed[key] = "true";
		}
	}
	return parsed;
}

function normalizeModality(value: string): "TEXT" | "AUDIO" {
	return value.trim().toLowerCase() === "text" ? "TEXT" : "AUDIO";
}

function getEventMessage(event: ErrorEvent): string {
	const error = event.error;
	if (error instanceof Error) return error.message;
	if (typeof event.message === "string" && event.message) return event.message;
	return String(error || event);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exit(1);
});
