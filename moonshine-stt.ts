import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type MoonshineFailureCode =
	| "dependency_unavailable"
	| "model_unavailable"
	| "invalid_audio"
	| "inference_failed"
	| "protocol"
	| "worker_unavailable"
	| "aborted"
	| "unknown";

type WorkerErrorPayload = {
	code?: string;
	phase?: string;
	message?: string;
};

type WorkerPayload = {
	type?: "ready" | "fatal" | "result";
	id?: string;
	ok?: boolean;
	text?: string;
	packageVersion?: string;
	modelArch?: string;
	error?: WorkerErrorPayload;
};

type PendingRequest = {
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abortHandler?: () => void;
	timer?: NodeJS.Timeout;
};

export class MoonshineSttError extends Error {
	constructor(
		message: string,
		public readonly code: MoonshineFailureCode,
		public readonly phase?: string,
	) {
		super(message);
		this.name = "MoonshineSttError";
	}
}

export type MoonshineWorkerStatus = {
	state: "unknown" | "starting" | "ready" | "unavailable" | "failed";
	packageVersion?: string;
	modelArch: "base";
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
	const parentCandidate = join(import.meta.dirname, "..", "listener", "moonshine_stt_worker.py");
	if (existsSync(parentCandidate)) return join(import.meta.dirname, "..");
	return import.meta.dirname;
}

function normalizeText(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

function normalizeFailureCode(raw: string | undefined): MoonshineFailureCode {
	const known: Record<MoonshineFailureCode, true> = {
		dependency_unavailable: true,
		model_unavailable: true,
		invalid_audio: true,
		inference_failed: true,
		protocol: true,
		worker_unavailable: true,
		aborted: true,
		unknown: true,
	};
	return raw && known[raw as MoonshineFailureCode] ? raw as MoonshineFailureCode : "unknown";
}

function workerError(payload: WorkerErrorPayload | undefined, fallbackCode: MoonshineFailureCode) {
	const code = payload?.code ? normalizeFailureCode(payload.code) : fallbackCode;
	const message = normalizeText(payload?.message || `Moonshine STT failed (${code})`).slice(0, 500);
	return new MoonshineSttError(message, code, payload?.phase);
}

class MoonshineSttWorker {
	private child?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRequest>();
	private booting?: Promise<void>;
	private stopping?: Promise<void>;
	private status: MoonshineWorkerStatus = { state: "unknown", modelArch: "base" };

	getStatus(): MoonshineWorkerStatus {
		return { ...this.status };
	}

async transcribe(filePath: string, signal?: AbortSignal) {
	if (signal?.aborted) throw new MoonshineSttError("Transcription aborted", "aborted");
	await this.ensureStarted(signal);
	if (signal?.aborted) throw new MoonshineSttError("Transcription aborted", "aborted");
	const child = this.child;
	if (!child || child.killed || this.status.state !== "ready") {
		throw new MoonshineSttError("Moonshine STT worker is unavailable", "worker_unavailable");
	}
	return await new Promise<string>((resolve, reject) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const abortHandler = () => this.settleError(id, new MoonshineSttError("Transcription aborted", "aborted"));
		const timeoutMs = Number.parseInt(process.env.PI_SPEAK_MOONSHINE_REQUEST_TIMEOUT_MS || "120000", 10);
		const timer = setTimeout(() => this.settleError(id, new MoonshineSttError("Moonshine STT transcription timed out", "worker_unavailable")), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000);
		timer.unref?.();
		signal?.addEventListener("abort", abortHandler, { once: true });
		this.pending.set(id, { resolve, reject, signal, abortHandler, timer });
		try {
			child.stdin.write(`${JSON.stringify({ type: "transcribe", id, file_path: filePath })}\n`, (error) => {
				if (error) this.settleError(id, new MoonshineSttError(error.message, "worker_unavailable"));
			});
		} catch (error) {
			this.settleError(id, new MoonshineSttError(error instanceof Error ? error.message : String(error), "worker_unavailable"));
		}
	});
}

	async stop() {
		if (this.stopping) return await this.stopping;
		this.stopping = this.stopInternal();
		try {
			await this.stopping;
		} finally {
			this.stopping = undefined;
		}
	}

	private async stopInternal() {
		const child = this.child;
		this.child = undefined;
		this.status = { state: "unknown", modelArch: "base" };
		this.rejectAll(new MoonshineSttError("Moonshine STT worker stopped", "worker_unavailable"));
		if (!child) return;
		try {
			child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
			child.stdin.end();
		} catch {}
		await new Promise<void>((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			child.once("exit", finish);
			timer = setTimeout(() => {
				try { child.kill(); } catch {}
				finish();
			}, 1_500);
			timer.unref?.();
		});
	}

	private async ensureStarted(signal?: AbortSignal) {
		if (this.child && !this.child.killed && this.status.state === "ready") return;
		let boot = this.booting;
		if (!boot) {
			boot = this.start();
			this.booting = boot;
			void boot.finally(() => {
				if (this.booting === boot) this.booting = undefined;
			}).catch(() => {});
		}
		if (!signal) return await boot;
		if (signal.aborted) throw new MoonshineSttError("Transcription aborted", "aborted");
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				const error = new MoonshineSttError("Transcription aborted", "aborted");
				this.failWorker(error);
				reject(error);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			boot.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	}

	private async start() {
		const script = join(getExtensionDir(), "listener", "moonshine_stt_worker.py");
		if (!existsSync(script)) {
			this.status = { state: "unavailable", modelArch: "base" };
			throw new MoonshineSttError(`Moonshine STT worker script not found: ${script}`, "worker_unavailable");
		}
		this.status = { state: "starting", modelArch: "base" };
		const child = spawn(getPythonExecutable(), ["-u", script], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
			env: { ...process.env },
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let stdoutBuffer = "";
		let lastStderr = "";
		child.stderr.on("data", (chunk: string) => {
			lastStderr = normalizeText(String(chunk)).slice(-500) || lastStderr;
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const settleReady = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const settleStartError = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			};
			const handleLine = (line: string) => {
				let payload: WorkerPayload;
				try {
					payload = JSON.parse(line) as WorkerPayload;
				} catch {
					const error = new MoonshineSttError("Moonshine worker emitted malformed JSON", "protocol");
					settleStartError(error);
					this.failWorker(error);
					return;
				}
				if (payload.type === "ready") {
					this.status = {
						state: "ready",
						packageVersion: payload.packageVersion,
						modelArch: "base",
					};
					settleReady();
					return;
				}
				if (payload.type === "fatal") {
					const error = workerError(payload.error, "worker_unavailable");
					this.status = { state: error.code === "dependency_unavailable" || error.code === "model_unavailable" ? "unavailable" : "failed", modelArch: "base" };
					settleStartError(error);
					return;
				}
				if (payload.type === "result" && payload.id) {
					if (payload.ok) this.settleSuccess(payload.id, normalizeText(payload.text || ""));
					else this.settleError(payload.id, workerError(payload.error, "unknown"));
				}
			};
			child.stdout.on("data", (chunk: string) => {
				stdoutBuffer += chunk;
				for (;;) {
					const newline = stdoutBuffer.indexOf("\n");
					if (newline < 0) break;
					const line = stdoutBuffer.slice(0, newline).trim();
					stdoutBuffer = stdoutBuffer.slice(newline + 1);
					if (line) handleLine(line);
				}
			});
			child.once("error", (error) => {
				const wrapped = new MoonshineSttError(error.message, "worker_unavailable");
				settleStartError(wrapped);
				this.failWorker(wrapped);
			});
			child.once("exit", (code) => {
				if (this.child === child) {
					this.child = undefined;
					this.status = { state: "failed", modelArch: "base" };
				}
				const error = new MoonshineSttError(lastStderr || `Moonshine STT worker exited (${code ?? "unknown"})`, "worker_unavailable");
				settleStartError(error);
				this.rejectAll(error);
			});
			const timeoutMs = Number.parseInt(process.env.PI_SPEAK_MOONSHINE_START_TIMEOUT_MS || "120000", 10);
			timer = setTimeout(() => {
				const error = new MoonshineSttError("Moonshine STT worker initialization timed out", "worker_unavailable");
				settleStartError(error);
				this.failWorker(error);
			}, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000);
			timer.unref?.();
		});
	}

	private failWorker(error: Error) {
		const child = this.child;
		this.child = undefined;
		this.status = { state: "failed", modelArch: "base" };
		this.rejectAll(error);
		try { child?.kill(); } catch {}
	}

	private settleSuccess(id: string, text: string) {
		const request = this.pending.get(id);
		if (!request) return;
		this.pending.delete(id);
		this.cleanupRequest(request);
		request.resolve(text);
	}

	private settleError(id: string, error: Error) {
		const request = this.pending.get(id);
		if (!request) return;
		this.pending.delete(id);
		this.cleanupRequest(request);
		request.reject(error);
	}

	private cleanupRequest(request: PendingRequest) {
		if (request.timer) clearTimeout(request.timer);
		if (request.signal && request.abortHandler) request.signal.removeEventListener("abort", request.abortHandler);
	}

	private rejectAll(error: Error) {
		for (const [id, request] of this.pending.entries()) {
			this.pending.delete(id);
			this.cleanupRequest(request);
			request.reject(error);
		}
	}
}

const worker = new MoonshineSttWorker();

export async function transcribeWithMoonshine(filePath: string, signal?: AbortSignal) {
	return await worker.transcribe(filePath, signal);
}

export async function shutdownMoonshineSttWorker() {
	await worker.stop();
}

export function getMoonshineWorkerStatus() {
	return worker.getStatus();
}
