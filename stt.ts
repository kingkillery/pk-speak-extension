import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { withAbortTimeout } from "./request-timeout.js";

export type SttProvider = "auto" | "local" | "openai" | "elevenlabs" | "google";

export type SttResult = {
	/**
	 * Selected provider identity from resolveSttProvider().
	 * When allowProviderFallback defaults to true, another backend may have produced `text`.
	 */
	provider: Exclude<SttProvider, "auto">;
	text: string;
	durationMs: number;
};

type WorkerRequest = {
	resolve: (text: string) => void;
	reject: (error: Error) => void;
};

function getOpenAiAudioKey() {
	return process.env.VOICE_TOOLS_OPENAI_KEY || process.env.PI_SPEAK_OPENAI_KEY || process.env.OPENAI_API_KEY || "";
}

function getElevenLabsKey() {
	return process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || "";
}

function getConfiguredGoogleCloudProject() {
	return (
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
		process.env.GCLOUD_PROJECT?.trim() ||
		process.env.PI_SPEAK_VERTEX_PROJECT?.trim() ||
		""
	);
}

function getGoogleSttLocation() {
	return process.env.PI_SPEAK_GOOGLE_STT_LOCATION?.trim() || "global";
}

function getGoogleSttModel() {
	return process.env.PI_SPEAK_GOOGLE_STT_MODEL?.trim() || "chirp_3";
}

function getGoogleSttLanguage() {
	return process.env.PI_SPEAK_STT_LANGUAGE?.trim() || "en-US";
}

function getGoogleSpeechApiEndpoint(location: string) {
	return location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
}

type GoogleRecognizeRequest = {
	recognizer: string;
	config: {
		autoDecodingConfig: Record<string, never>;
		model: string;
		languageCodes: string[];
	};
	content: Buffer;
};

type GoogleRecognizeResponse = {
	results?: Array<{
		alternatives?: Array<{ transcript?: string | null } | null> | null;
	} | null> | null;
};

type GoogleRecognizeCallOptions = {
	timeout?: number;
};

type GoogleSpeechClientLike = {
	getProjectId(): Promise<string>;
	recognize(
		request: GoogleRecognizeRequest,
		options?: GoogleRecognizeCallOptions,
	): Promise<[GoogleRecognizeResponse, ...unknown[]] | GoogleRecognizeResponse>;
	close?(): Promise<void>;
};

export const testOverrides = {
	createGoogleSpeechClient: null as
		| null
		| ((options: { apiEndpoint: string; location: string }) => GoogleSpeechClientLike | Promise<GoogleSpeechClientLike>),
};

function getPythonExecutable() {
	if (process.env.PI_SPEAK_PYTHON?.trim()) return process.env.PI_SPEAK_PYTHON.trim();
	if (existsSync("C:/Python314/python.exe")) return "C:/Python314/python.exe";
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const localPy = join(home, "AppData", "Local", "Microsoft", "WindowsApps", "python3.exe");
	if (existsSync(localPy)) return localPy;
	return "python";
}

function getExtensionDir() {
	const parentCandidate = join(import.meta.dirname, "..", "listener", "stt_worker.py");
	if (existsSync(parentCandidate)) return join(import.meta.dirname, "..");
	return import.meta.dirname;
}

function getLocalSttWorkerEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
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
	if (getElevenLabsKey()) return "elevenlabs";
	if (getOpenAiAudioKey()) return "openai";
	return "local";
}

function normalizeTranscriptionText(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

function flattenGoogleTranscript(response: GoogleRecognizeResponse | null | undefined) {
	const parts: string[] = [];
	for (const result of response?.results || []) {
		const transcript = result?.alternatives?.[0]?.transcript;
		if (transcript) parts.push(transcript);
	}
	return normalizeTranscriptionText(parts.join(" "));
}

function googleTranscriptionHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") {
		const message = String(error);
		const match = message.match(/\b(429|5\d\d)\b/);
		return match ? Number(match[1]) : undefined;
	}
	const err = error as { code?: number | string; status?: number | string; message?: string };
	const rawCode = err.code ?? err.status;
	const code = typeof rawCode === "number" ? rawCode : Number(rawCode);
	if (Number.isFinite(code)) {
		if (code === 8) return 429; // RESOURCE_EXHAUSTED
		if (code === 4) return 504; // DEADLINE_EXCEEDED
		if (code === 13) return 500; // INTERNAL
		if (code === 14) return 503; // UNAVAILABLE
		if (code === 429 || (code >= 500 && code <= 599)) return code;
	}
	const message = err.message || String(error);
	const match = message.match(/\b(429|5\d\d)\b/);
	return match ? Number(match[1]) : undefined;
}

function getOutboundTimeoutMs() {
	const parsed = Number.parseInt(process.env.PI_SPEAK_OUTBOUND_TIMEOUT_MS || "30000", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

const googleSpeechClients = new Map<string, Promise<GoogleSpeechClientLike>>();

async function createGoogleSpeechClient(location: string): Promise<GoogleSpeechClientLike> {
	const apiEndpoint = getGoogleSpeechApiEndpoint(location);
	if (testOverrides.createGoogleSpeechClient) {
		return await testOverrides.createGoogleSpeechClient({ apiEndpoint, location });
	}
	const speech = await import("@google-cloud/speech");
	return new speech.v2.SpeechClient({ apiEndpoint }) as unknown as GoogleSpeechClientLike;
}

async function getGoogleSpeechClient(location: string): Promise<{ apiEndpoint: string; client: GoogleSpeechClientLike }> {
	const apiEndpoint = getGoogleSpeechApiEndpoint(location);
	let pending = googleSpeechClients.get(apiEndpoint);
	if (!pending) {
		pending = createGoogleSpeechClient(location);
		googleSpeechClients.set(apiEndpoint, pending);
		try {
			await pending;
		} catch (error) {
			if (googleSpeechClients.get(apiEndpoint) === pending) {
				googleSpeechClients.delete(apiEndpoint);
			}
			throw error;
		}
	}
	return { apiEndpoint, client: await pending };
}

async function resolveGoogleCloudProject(client: GoogleSpeechClientLike) {
	const configured = getConfiguredGoogleCloudProject();
	if (configured) return configured;
	try {
		const discovered = (await client.getProjectId())?.trim();
		if (discovered) return discovered;
	} catch {
		// Fall through to actionable configuration error.
	}
	throw new Error(
		"GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT / PI_SPEAK_VERTEX_PROJECT) is required for Google STT, or configure Application Default Credentials with a detectable project",
	);
}

async function closeGoogleSpeechClient(client: GoogleSpeechClientLike | undefined) {
	if (!client?.close) return;
	try {
		await client.close();
	} catch {
		// Best-effort channel release; do not mask the original transcription outcome.
	}
}

async function evictGoogleSpeechClient(apiEndpoint: string) {
	const pending = googleSpeechClients.get(apiEndpoint);
	if (!pending) return;
	googleSpeechClients.delete(apiEndpoint);
	try {
		await closeGoogleSpeechClient(await pending);
	} catch {
		// Creation may have failed; nothing left to close.
	}
}

async function shutdownGoogleSpeechClients() {
	const pendingClients = [...googleSpeechClients.values()];
	googleSpeechClients.clear();
	for (const pending of pendingClients) {
		try {
			await closeGoogleSpeechClient(await pending);
		} catch {
			// Best-effort cleanup across cached endpoints.
		}
	}
}

function isGoogleRpcCancelled(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	if (message === "Transcription aborted" || message === "Outbound request timed out") return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	return /Outbound request timed out|Transcription aborted/i.test(message);
}

async function transcribeWithGoogle(filePath: string, _mimeType?: string, signal?: AbortSignal) {
	const location = getGoogleSttLocation();
	const model = getGoogleSttModel();
	const language = getGoogleSttLanguage();
	const timeout = getOutboundTimeoutMs();
	let apiEndpoint: string | undefined;
	try {
		const resolved = await getGoogleSpeechClient(location);
		apiEndpoint = resolved.apiEndpoint;
		const client = resolved.client;
		const project = await resolveGoogleCloudProject(client);
		const content = await readFile(filePath);
		const request: GoogleRecognizeRequest = {
			recognizer: `projects/${project}/locations/${location}/recognizers/_`,
			config: {
				autoDecodingConfig: {},
				model,
				languageCodes: [language],
			},
			content,
		};

		const response = await withAbortTimeout(async (requestSignal) => {
			if (requestSignal.aborted) throw new Error("Transcription aborted");
			return await new Promise<GoogleRecognizeResponse>((resolve, reject) => {
				const onAbort = () => reject(new Error("Transcription aborted"));
				requestSignal.addEventListener("abort", onAbort, { once: true });
				Promise.resolve(client.recognize(request, { timeout }))
					.then((result) => {
						const response = Array.isArray(result) ? result[0] : result;
						resolve(response || {});
					})
					.catch(reject)
					.finally(() => requestSignal.removeEventListener("abort", onAbort));
			});
		}, signal, timeout);
		return flattenGoogleTranscript(response);
	} catch (error) {
		if (apiEndpoint && isGoogleRpcCancelled(error)) {
			await evictGoogleSpeechClient(apiEndpoint);
		}
		if (error instanceof Error && error.message === "Transcription aborted") throw error;
		const status = googleTranscriptionHttpStatus(error);
		if (status !== undefined) {
			throw new Error(`Google transcription failed (${status})`);
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
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
	const response = await withAbortTimeout(
		(requestSignal) =>
			fetch(`${process.env.PI_SPEAK_OPENAI_BASE_URL || "https://api.openai.com/v1"}/audio/transcriptions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
				body: form,
				signal: requestSignal,
			}),
		signal,
	);
	if (!response.ok) {
		throw new Error(`OpenAI transcription failed (${response.status})`);
	}
	const json = (await response.json()) as { text?: string };
	return normalizeTranscriptionText(json.text || "");
}

async function transcribeWithElevenLabs(filePath: string, mimeType?: string, signal?: AbortSignal) {
	const apiKey = getElevenLabsKey();
	if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs STT");
	const fileBytes = await readFile(filePath);
	const form = new FormData();
	form.set("model_id", process.env.PI_SPEAK_ELEVENLABS_STT_MODEL || "scribe_v2");
	form.set("file", new File([fileBytes], basename(filePath), {
		type: mimeType || "application/octet-stream",
	}));
	form.set("language_code", process.env.PI_SPEAK_STT_LANGUAGE || "en");
	form.set("tag_audio_events", "false");
	form.set("diarize", "false");
	const response = await withAbortTimeout(
		(requestSignal) =>
			fetch("https://api.elevenlabs.io/v1/speech-to-text", {
				method: "POST",
				headers: {
					"xi-api-key": apiKey,
				},
				body: form,
				signal: requestSignal,
			}),
		signal,
	);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`ElevenLabs transcription failed (${response.status})${body ? `: ${body.slice(0, 240)}` : ""}`);
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
	await shutdownGoogleSpeechClients();
}

export type TranscribeAudioBufferOptions = {
	signal?: AbortSignal;
	/**
	 * When false, remote STT 429/5xx errors are not retried via another provider,
	 * pinning the actual backend (needed for benchmarks). Defaults to true so
	 * existing callers keep current fallback behavior.
	 */
	allowProviderFallback?: boolean;
};

function isAbortSignal(value: unknown): value is AbortSignal {
	return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}

function normalizeTranscribeAudioBufferOptions(
	signalOrOptions?: AbortSignal | TranscribeAudioBufferOptions,
): TranscribeAudioBufferOptions {
	if (!signalOrOptions) return {};
	if (isAbortSignal(signalOrOptions)) {
		return { signal: signalOrOptions };
	}
	return signalOrOptions as TranscribeAudioBufferOptions;
}

export async function transcribeAudioBuffer(
	buffer: Buffer,
	mimeType?: string,
	signalOrOptions?: AbortSignal | TranscribeAudioBufferOptions,
): Promise<SttResult> {
	const options = normalizeTranscribeAudioBufferOptions(signalOrOptions);
	const allowProviderFallback = options.allowProviderFallback !== false;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-speak-stt-"));
	const extension = mimeTypeToExtension(mimeType);
	const filePath = join(tempDir, `input${extension}`);
	const startedAt = Date.now();
	try {
		await writeFile(filePath, buffer);
		const provider = resolveSttProvider();
		const text = provider === "google"
			? await transcribeWithGoogleFallback(filePath, mimeType, options.signal, allowProviderFallback)
			: provider === "elevenlabs"
				? await transcribeWithElevenLabsFallback(filePath, mimeType, options.signal, allowProviderFallback)
				: provider === "openai"
					? await transcribeWithOpenAiFallback(filePath, mimeType, options.signal, allowProviderFallback)
					: await transcribeWithLocal(filePath, options.signal);
		return { provider, text, durationMs: Date.now() - startedAt };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function transcribeWithOpenAiFallback(
	filePath: string,
	mimeType?: string,
	signal?: AbortSignal,
	allowProviderFallback = true,
) {
	try {
		return await transcribeWithOpenAI(filePath, mimeType, signal);
	} catch (error) {
		if (!allowProviderFallback || !isRetryableOpenAiTranscriptionError(error)) throw error;
		return await transcribeWithLocal(filePath, signal);
	}
}

async function transcribeWithElevenLabsFallback(
	filePath: string,
	mimeType?: string,
	signal?: AbortSignal,
	allowProviderFallback = true,
) {
	try {
		return await transcribeWithElevenLabs(filePath, mimeType, signal);
	} catch (error) {
		if (!allowProviderFallback || !isRetryableElevenLabsTranscriptionError(error)) throw error;
		if (getOpenAiAudioKey()) return await transcribeWithOpenAI(filePath, mimeType, signal);
		return await transcribeWithLocal(filePath, signal);
	}
}

async function transcribeWithGoogleFallback(
	filePath: string,
	mimeType?: string,
	signal?: AbortSignal,
	allowProviderFallback = true,
) {
	try {
		return await transcribeWithGoogle(filePath, mimeType, signal);
	} catch (error) {
		if (!allowProviderFallback || !isRetryableGoogleTranscriptionError(error)) throw error;
		if (getOpenAiAudioKey()) return await transcribeWithOpenAI(filePath, mimeType, signal);
		return await transcribeWithLocal(filePath, signal);
	}
}

function isRetryableOpenAiTranscriptionError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return /OpenAI transcription failed \((429|5\d\d)\)/.test(message);
}

function isRetryableElevenLabsTranscriptionError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return /ElevenLabs transcription failed \((429|5\d\d)\)/.test(message);
}

function isRetryableGoogleTranscriptionError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return /Google transcription failed \((429|5\d\d)\)/.test(message);
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

export async function transcribeWithWhisperX(filePath: string, signal?: AbortSignal): Promise<string> {
	const python = getPythonExecutable();
	let pyExec = python;
	const gpuPy = join(process.cwd(), ".venv-gpu", "Scripts", "python.exe");
	if (existsSync(gpuPy)) {
		pyExec = gpuPy;
	}
	const script = join(getExtensionDir(), "listener", "whisperx_transcribe.py");

	return new Promise<string>((resolve, reject) => {
		const child = spawn(pyExec, [script, filePath], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...getLocalSttWorkerEnv(),
				WHISPER_DEVICE: process.env.WHISPER_DEVICE || "cuda",
				WHISPER_COMPUTE: process.env.WHISPER_COMPUTE || "float16",
			},
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || `WhisperX process exited with code ${code}`));
				return;
			}
			try {
				const res = JSON.parse(stdout) as { success: boolean; text?: string; error?: string };
				if (res.success) {
					resolve(res.text || "");
				} else {
					reject(new Error(res.error || "WhisperX transcription failed"));
				}
			} catch (err) {
				reject(new Error(`Failed to parse WhisperX response: ${stdout}`));
			}
		});

		signal?.addEventListener("abort", () => {
			child.kill();
			reject(new Error("WhisperX aborted"));
		});
	});
}

