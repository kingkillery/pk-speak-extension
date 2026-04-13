import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export type SttProvider = "auto" | "local" | "openai";

export type SttResult = {
	provider: Exclude<SttProvider, "auto">;
	text: string;
};

function getOpenAiAudioKey() {
	return process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY || "";
}

function getPythonExecutable() {
	if (process.env.PI_SPEAK_PYTHON?.trim()) return process.env.PI_SPEAK_PYTHON.trim();
	if (existsSync("C:/Python314/python.exe")) return "C:/Python314/python.exe";
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const localPy = join(home, "AppData", "Local", "Microsoft", "WindowsApps", "python3.exe");
	if (existsSync(localPy)) return localPy;
	return "python";
}

export function resolveSttProvider(): Exclude<SttProvider, "auto"> {
	const configured = (process.env.PI_SPEAK_REMOTE_STT_PROVIDER || "auto").trim().toLowerCase() as SttProvider;
	if (configured !== "auto") return configured;
	if (getOpenAiAudioKey()) return "openai";
	return "local";
}

function normalizeTranscriptionText(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

async function transcribeWithOpenAI(filePath: string, mimeType?: string, signal?: AbortSignal) {
	const apiKey = getOpenAiAudioKey();
	if (!apiKey) throw new Error("OPENAI_API_KEY or VOICE_TOOLS_OPENAI_KEY is required for OpenAI STT");
	const fileBytes = await readFile(filePath);
	const form = new FormData();
	form.set(
		"file",
		new File([fileBytes], basename(filePath), {
			type: mimeType || "application/octet-stream",
		}),
	);
	form.set("model", process.env.PI_SPEAK_REMOTE_OPENAI_STT_MODEL || "whisper-1");
	form.set("response_format", "json");
	const response = await fetch(
		`${process.env.PI_SPEAK_OPENAI_BASE_URL || "https://api.openai.com/v1"}/audio/transcriptions`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			body: form,
			signal,
		},
	);
	if (!response.ok) {
		throw new Error(`OpenAI transcription failed (${response.status})`);
	}
	const json = (await response.json()) as { text?: string };
	return normalizeTranscriptionText(json.text || "");
}

async function transcribeWithLocal(filePath: string, signal?: AbortSignal) {
	return new Promise<string>((resolve, reject) => {
		const python = getPythonExecutable();
		const script = join(process.cwd(), "listener", "transcribe_file.py");
		const child = spawn(python, [script, filePath], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
			env: {
				...process.env,
			},
		});

		let stdout = "";
		let stderr = "";

		const abortHandler = () => {
			try {
				child.kill();
			} catch {}
			reject(new Error("Transcription aborted"));
		};
		signal?.addEventListener("abort", abortHandler, { once: true });

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || `Local transcription failed (${code})`));
				return;
			}
			try {
				const json = JSON.parse(stdout) as { success?: boolean; text?: string; error?: string };
				if (!json.success) {
					reject(new Error(json.error || "Local transcription failed"));
					return;
				}
				resolve(normalizeTranscriptionText(json.text || ""));
			} catch (error) {
				reject(error);
			}
		});
	});
}

export async function transcribeAudioBuffer(buffer: Buffer, mimeType?: string, signal?: AbortSignal): Promise<SttResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-stt-"));
	const extension = mimeTypeToExtension(mimeType);
	const filePath = join(tempDir, `input${extension}`);
	try {
		await writeFile(filePath, buffer);
		const provider = resolveSttProvider();
		const text =
			provider === "openai"
				? await transcribeWithOpenAI(filePath, mimeType, signal)
				: await transcribeWithLocal(filePath, signal);
		return { provider, text };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function mimeTypeToExtension(mimeType?: string) {
	const normalized = (mimeType || "").toLowerCase();
	if (normalized.includes("webm")) return ".webm";
	if (normalized.includes("ogg")) return ".ogg";
	if (normalized.includes("wav")) return ".wav";
	if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
	if (normalized.includes("mp4") || normalized.includes("m4a")) return ".m4a";
	return ".bin";
}
