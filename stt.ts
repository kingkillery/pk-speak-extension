import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

export type SttProvider = "auto" | "local" | "openai";

export type SttResult = {
	provider: Exclude<SttProvider, "auto">;
	text: string;
	durationMs: number;
};

type WorkerRequest = {
	resolve: (text: string) => void;
	reject: (error: Error) => void;
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

function getExtensionDir() {
	const parentCandidate = join(__dirname, "..", "listener", "stt_worker.py");
	if (existsSync(parentCandidate)) return join(__dirname, "..");
	return __dirname;
}

function getLocalSttWorkerEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH || "",
		PYTHONPATH: process.env.PYTHONPATH || "",
	};
	const optionalEnv = {
		PI_SPEAK_REMOTE_WHISPER_MODEL: process.env.PI_SPEAK_REMOTE_WHISPER_MODEL,
		WHISPER_MODEL: process.env.WHISPER_MODEL,
		WHISPER_DEVICE: process.env.WHISPER_DEVICE,
		WHISPER_COMPUTE: process.env.WHISPER_COMPUTE,
	};
	for (const [key, value] of Object.entries(optionalEnv)) {
		const trimmed = value?.trim();
		if (trimmed) env[key] = trimmed;
	}
	return env;
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

class LocalSttWorker {
	private child?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, WorkerRequest>();
	private booting?: Promise<void>;
	private restarting = false;

	async transcribe(filePath: string, signal?: AbortSignal) {
		await this.ensureStarted();
		return await new Promise<string>((resolve, reject) => {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const abortHandler = () => {
				this.pending.delete(id);
				reject(new Error("Transcription aborted"));
			};
			signal?.addEventListener("abort", abortHandler, { once: true });
			this.pending.set(id, {
				resolve: (text) => {
					signal?.removeEventListener("abort", abortHandler);
					resolve(text);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", abortHandler);
					reject(error);
				},
			});
			this.child?.stdin.write(`${JSON.stringify({ id, file_path: filePath })}\n`);
		});
	}

	async stop() {
		for (const [id, request] of this.pending.entries()) {
			this.pending.delete(id);
			request.reject(new Error("STT worker stopped"));
		}
		if (!this.child) return;
		try {
			this.child.stdin.end();
		} catch {}
		try {
			this.child.kill();
		} catch {}
		this.child = undefined;
	}

	private async ensureStarted() {
		if (this.child && !this.child.killed) return;
		if (!this.booting) {
			this.booting = this.start();
		}
		try {
			await this.booting;
		} finally {
			this.booting = undefined;
		}
	}

	private async start() {
		const python = getPythonExecutable();
		const script = join(getExtensionDir(), "listener", "stt_worker.py");
		const child = spawn(python, ["-u", script], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
			env: getLocalSttWorkerEnv(),
		});
		child.stdout.setEncoding("utf8");
		let stdoutBuffer = "";
		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			for (;;) {
				const newline = stdoutBuffer.indexOf("\n");
				if (newline < 0) break;
				const line = stdoutBuffer.slice(0, newline).trim();
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				if (!line) continue;
				try {
					const payload = JSON.parse(line) as { id?: string; ok?: boolean; text?: string; error?: string };
					if (!payload.id) continue;
					const request = this.pending.get(payload.id);
					if (!request) continue;
					this.pending.delete(payload.id);
					if (payload.ok) request.resolve(normalizeTranscriptionText(payload.text || ""));
					else request.reject(new Error(payload.error || "Local transcription failed"));
				} catch {}
			}
		});
		child.stderr.setEncoding("utf8");
		let lastStderr = "";
		child.stderr.on("data", (chunk: string) => {
			lastStderr = String(chunk).trim() || lastStderr;
		});
		child.on("exit", (code) => {
			this.child = undefined;
			const error = new Error(lastStderr || `Local STT worker exited (${code ?? "unknown"})`);
			for (const [id, request] of this.pending.entries()) {
				this.pending.delete(id);
				request.reject(error);
			}
		});
		child.on("error", (error) => {
			this.child = undefined;
			for (const [id, request] of this.pending.entries()) {
				this.pending.delete(id);
				request.reject(error);
			}
		});
		this.child = child;
	}

	async transcribeWithRestart(filePath: string, signal?: AbortSignal) {
		try {
			return await this.transcribe(filePath, signal);
		} catch (error) {
			if (this.restarting) throw error;
			this.restarting = true;
			try {
				await this.stop();
				return await this.transcribe(filePath, signal);
			} finally {
				this.restarting = false;
			}
		}
	}
}

const localWorker = new LocalSttWorker();

async function transcribeWithLocal(filePath: string, signal?: AbortSignal) {
	return await localWorker.transcribeWithRestart(filePath, signal);
}

export async function shutdownLocalSttWorker() {
	await localWorker.stop();
}

export async function transcribeAudioBuffer(buffer: Buffer, mimeType?: string, signal?: AbortSignal): Promise<SttResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-stt-"));
	const extension = mimeTypeToExtension(mimeType);
	const filePath = join(tempDir, `input${extension}`);
	const startedAt = Date.now();
	try {
		await writeFile(filePath, buffer);
		const provider = resolveSttProvider();
		const text =
			provider === "openai"
				? await transcribeWithOpenAI(filePath, mimeType, signal)
				: await transcribeWithLocal(filePath, signal);
		return { provider, text, durationMs: Date.now() - startedAt };
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
