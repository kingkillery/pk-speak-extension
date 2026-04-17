import { createReadStream, existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BusyError, RemoteTurnResult } from "./remote-turn-manager.js";

export type ControlServerState = {
	enabled: boolean;
	host?: string;
	port?: number;
	authToken?: string;
};

export type ControlActionResult = {
	ok: boolean;
	message: string;
	[key: string]: unknown;
};

export type ControlServerStatus = {
	speak: unknown;
	mono: unknown;
	phone: unknown;
	remote: {
		enabled: boolean;
		host: string;
		port: number;
		authRequired: boolean;
		defaultTarget?: string;
		currentSession?: string;
		availableTargets?: string[];
	};
};

export type ControlServerDiagnostics = {
	status: ControlServerStatus;
	lastErrors?: Record<string, string | undefined>;
	recentTimings?: unknown;
	queue?: unknown;
	summary?: {
		remoteEnabled: boolean;
		queueState: "idle" | "queued" | "busy";
		queueDepth: number;
		phoneLinked: boolean;
		monoState: string;
		activeErrorSources: string[];
		currentSession?: string;
		defaultTarget?: string;
		availableTargetCount: number;
	};
	auth?: {
		authRequired: boolean;
		allowQueryTokenForAudio: boolean;
		allowedOrigins: string[];
	};
	providers?: unknown;
};

export type ControlServerOptions = {
	state: ControlServerState;
	onStateChange: (patch: Partial<ControlServerState>) => void;
	getStatus: () => ControlServerStatus;
	getDiagnostics: () => ControlServerDiagnostics;
	getRoutingStatus: () => {
		defaultTarget?: string;
		currentSession?: string;
		availableTargets: string[];
	};
	setRoutingTarget: (target?: string) => Promise<ControlActionResult> | ControlActionResult;
	onMonoAction: (action: "on" | "off" | "status") => Promise<ControlActionResult> | ControlActionResult;
	onSpeakAction: (
		action: "on" | "off" | "stop" | "status" | "test" | "providers" | "provider" | "rewrite",
		value?: string,
	) => Promise<ControlActionResult> | ControlActionResult;
	onPhoneAction: (
		action: "on" | "off" | "status" | "code" | "unpair",
	) => Promise<ControlActionResult> | ControlActionResult;
	onTextTurn: (text: string, includeAudio: boolean, target?: string) => Promise<RemoteTurnResult>;
	onVoiceTurn: (buffer: Buffer, mimeType: string | undefined, includeAudio: boolean, target?: string) => Promise<RemoteTurnResult>;
};

type AudioArtifact = {
	id: string;
	path: string;
	mimeType: string;
	expiresAt: number;
};

type RateLimitBucket = {
	windowStartedAt: number;
	control: number;
	voice: number;
};

const DEFAULT_HOST = process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0";
const DEFAULT_PORT = Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10);
const AUDIO_TTL_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_AUDIO_TTL_MS || "600000", 10);
const CLEANUP_INTERVAL_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_AUDIO_CLEANUP_MS || "30000", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_TIMEOUT_MS || "180000", 10);
const TEXT_BODY_LIMIT_BYTES = Number.parseInt(process.env.PI_SPEAK_HTTP_TEXT_BODY_LIMIT_BYTES || "65536", 10);
const VOICE_BODY_LIMIT_BYTES = Number.parseInt(process.env.PI_SPEAK_HTTP_VOICE_BODY_LIMIT_BYTES || "26214400", 10);
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_RATE_LIMIT_WINDOW_MS || "60000", 10);
const RATE_LIMIT_CONTROL = Number.parseInt(process.env.PI_SPEAK_HTTP_RATE_LIMIT_CONTROL || "20", 10);
const RATE_LIMIT_VOICE = Number.parseInt(process.env.PI_SPEAK_HTTP_RATE_LIMIT_VOICE || "6", 10);
const ALLOW_QUERY_TOKEN_FOR_AUDIO = isTruthy(process.env.PI_SPEAK_HTTP_ALLOW_QUERY_TOKEN_FOR_AUDIO || "false");
const REMOTE_APP_DIR = resolveRemoteAppDir();
const ALLOWED_VOICE_CONTENT_TYPES = [
	"audio/webm",
	"audio/ogg",
	"audio/wav",
	"audio/x-wav",
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/x-m4a",
	"audio/aac",
	"application/octet-stream",
];

function buildDiagnosticsSummary(
	diagnostics: ControlServerDiagnostics,
	routing: { defaultTarget?: string; currentSession?: string; availableTargets: string[] },
): NonNullable<ControlServerDiagnostics["summary"]> {
	const status = diagnostics.status as Record<string, any>;
	const queue = (diagnostics.queue as Record<string, unknown> | undefined) ?? {};
	const queueDepth = typeof queue.queued === "number" ? queue.queued : 0;
	const queueState = queue.processing ? "busy" : queueDepth > 0 ? "queued" : "idle";
	const lastErrors = diagnostics.lastErrors ?? {};
	const activeErrorSources = Object.entries(lastErrors)
		.filter(([, value]) => typeof value === "string" && value.trim().length > 0)
		.map(([source]) => source)
		.sort((left, right) => left.localeCompare(right));
	return {
		remoteEnabled: !!status.remote?.enabled,
		queueState,
		queueDepth,
		phoneLinked: !!status.phone?.linkedChatId,
		monoState: typeof status.mono?.status === "string"
			? status.mono.status
			: status.mono?.running
				? "running"
				: "off",
		activeErrorSources,
		currentSession: routing.currentSession ?? status.remote?.currentSession,
		defaultTarget: routing.defaultTarget ?? status.remote?.defaultTarget,
		availableTargetCount: Array.isArray(routing.availableTargets) ? routing.availableTargets.length : 0,
	};
}

export class ControlServer {
	private server?: Server;
	private cleanupTimer?: NodeJS.Timeout;
	private readonly onStateChange: (patch: Partial<ControlServerState>) => void;
	private readonly getStatus: () => ControlServerStatus;
	private readonly getDiagnostics: () => ControlServerDiagnostics;
	private readonly getRoutingStatus: ControlServerOptions["getRoutingStatus"];
	private readonly setRoutingTarget: ControlServerOptions["setRoutingTarget"];
	private readonly onMonoAction: ControlServerOptions["onMonoAction"];
	private readonly onSpeakAction: ControlServerOptions["onSpeakAction"];
	private readonly onPhoneAction: ControlServerOptions["onPhoneAction"];
	private readonly onTextTurn: ControlServerOptions["onTextTurn"];
	private readonly onVoiceTurn: ControlServerOptions["onVoiceTurn"];
	private readonly state: ControlServerState;
	private readonly audioArtifacts = new Map<string, AudioArtifact>();
	private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();
	private readonly allowedOrigins = parseAllowedOrigins(process.env.PI_SPEAK_HTTP_ALLOWED_ORIGINS || "");

	constructor(options: ControlServerOptions) {
		this.state = {
			enabled: options.state.enabled,
			host: options.state.host ?? DEFAULT_HOST,
			port: options.state.port ?? DEFAULT_PORT,
			authToken: options.state.authToken || process.env.PI_SPEAK_HTTP_TOKEN || randomUUID(),
		};
		this.onStateChange = options.onStateChange;
		this.getStatus = options.getStatus;
		this.getDiagnostics = options.getDiagnostics;
		this.getRoutingStatus = options.getRoutingStatus;
		this.setRoutingTarget = options.setRoutingTarget;
		this.onMonoAction = options.onMonoAction;
		this.onSpeakAction = options.onSpeakAction;
		this.onPhoneAction = options.onPhoneAction;
		this.onTextTurn = options.onTextTurn;
		this.onVoiceTurn = options.onVoiceTurn;
	}

	getRuntimeState() {
		return {
			enabled: !!this.server,
			host: this.state.host ?? DEFAULT_HOST,
			port: this.state.port ?? DEFAULT_PORT,
			authToken: this.state.authToken || "",
			allowedOrigins: [...this.allowedOrigins],
		};
	}

	async start() {
		if (this.server) return this.getRuntimeState();
		const host = this.state.host ?? DEFAULT_HOST;
		const port = this.state.port ?? DEFAULT_PORT;
		const authToken = this.state.authToken || randomUUID();
		this.state.enabled = true;
		this.state.host = host;
		this.state.port = port;
		this.state.authToken = authToken;

		this.server = createServer((req, res) => {
			void this.handleRequest(req, res).catch((error) => {
				if (error instanceof BusyError) {
					this.writeJson(res, 429, { ok: false, busy: true, error: error.message });
					return;
				}
				if (error instanceof RequestLimitError) {
					this.writeJson(res, error.statusCode, { ok: false, error: error.message });
					return;
				}
				this.writeJson(res, 500, { ok: false, error: getErrorMessage(error) });
			});
		});

		await new Promise<void>((resolve, reject) => {
			const server = this.server!;
			server.once("error", reject);
			server.listen(port, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (address && typeof address === "object") {
			this.state.port = address.port;
		}

		this.cleanupTimer = setInterval(() => this.cleanupExpiredAudio(), CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref?.();
		this.onStateChange({ enabled: true, host, port: this.state.port, authToken });
		return this.getRuntimeState();
	}

	async stop() {
		if (!this.server) return;
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		this.onStateChange({ enabled: false });
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
		this.applyCors(req, res, url);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}

		if (req.method === "GET" && (await this.handlePublicRoute(url, res))) {
			return;
		}

		const localRequest = isLocalRequest(req, url);
		if (req.method === "GET" && url.pathname.startsWith("/v1/audio/")) {
			if (!this.isAuthorized(req, url, ALLOW_QUERY_TOKEN_FOR_AUDIO)) {
				this.writeJson(res, 401, { ok: false, error: "Unauthorized" });
				return;
			}
			const id = decodeURIComponent(url.pathname.slice("/v1/audio/".length));
			await this.handleAudioRequest(id, res);
			return;
		}

		if (!this.isAuthorized(req, url, false)) {
			this.writeJson(res, 401, { ok: false, error: "Unauthorized" });
			return;
		}

		const rateLimitError = this.checkRateLimit(req, url, localRequest);
		if (rateLimitError) {
			this.writeJson(res, 429, rateLimitError);
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/health") {
			this.writeJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/status") {
			this.writeJson(res, 200, { ok: true, status: this.getStatus() });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/diagnostics") {
			const routing = this.getRoutingStatus();
			const diagnostics = this.getDiagnostics();
			this.writeJson(res, 200, {
				ok: true,
				diagnostics: {
					...diagnostics,
					summary: buildDiagnosticsSummary(diagnostics, routing),
					routing,
					auth: {
						authRequired: !!this.state.authToken,
						allowQueryTokenForAudio: ALLOW_QUERY_TOKEN_FOR_AUDIO,
						allowedOrigins: [...this.allowedOrigins],
					},
				},
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/route") {
			this.writeJson(res, 200, {
				ok: true,
				route: this.getRoutingStatus(),
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/route") {
			const body = await this.readTextBody(req, TEXT_BODY_LIMIT_BYTES);
			const payload = parseJson<Record<string, unknown>>(body);
			const target = typeof payload?.target === "string" ? payload.target : "";
			const result = await this.setRoutingTarget(target.trim() || undefined);
			this.writeJson(res, result.ok ? 200 : 400, {
				ok: result.ok,
				message: result.message,
				route: this.getRoutingStatus(),
			});
			return;
		}

		if (req.method === "GET" && url.pathname.startsWith("/v1/mono/")) {
			const action = decodeURIComponent(url.pathname.slice("/v1/mono/".length)) as "on" | "off" | "status";
			this.writeJson(res, 200, await this.onMonoAction(action));
			return;
		}

		if (req.method === "GET" && url.pathname.startsWith("/v1/phone/")) {
			const action = decodeURIComponent(url.pathname.slice("/v1/phone/".length)) as
				| "on"
				| "off"
				| "status"
				| "code"
				| "unpair";
			this.writeJson(res, 200, await this.onPhoneAction(action));
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/speak/providers") {
			this.writeJson(res, 200, await this.onSpeakAction("providers"));
			return;
		}

		if (req.method === "GET" && url.pathname.startsWith("/v1/speak/provider/")) {
			const value = decodeURIComponent(url.pathname.slice("/v1/speak/provider/".length));
			this.writeJson(res, 200, await this.onSpeakAction("provider", value));
			return;
		}

		if (req.method === "GET" && url.pathname.startsWith("/v1/speak/rewrite/")) {
			const value = decodeURIComponent(url.pathname.slice("/v1/speak/rewrite/".length));
			this.writeJson(res, 200, await this.onSpeakAction("rewrite", value));
			return;
		}

		if (req.method === "GET" && url.pathname.startsWith("/v1/speak/")) {
			const action = decodeURIComponent(url.pathname.slice("/v1/speak/".length)) as
				| "on"
				| "off"
				| "stop"
				| "status"
				| "test";
			this.writeJson(res, 200, await this.onSpeakAction(action));
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/turn/text") {
			const text = url.searchParams.get("text") || "";
			const includeAudio = isTruthy(url.searchParams.get("audio"));
			const target = url.searchParams.get("target")?.trim() || undefined;
			const result = await this.withTimeout(this.onTextTurn(text, includeAudio, target));
			this.writeJson(res, 200, await this.createTurnPayload(result));
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/turn/text") {
			const body = await this.readTextBody(req, TEXT_BODY_LIMIT_BYTES);
			const payload = parseJson<Record<string, unknown>>(body);
			const text = typeof payload?.text === "string" ? payload.text : "";
			const includeAudio = !!payload?.audio;
			const target = typeof payload?.target === "string" ? payload.target.trim() || undefined : undefined;
			const result = await this.withTimeout(this.onTextTurn(text, includeAudio, target));
			this.writeJson(res, 200, await this.createTurnPayload(result));
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/turn/voice") {
			const mimeType = getPrimaryHeaderValue(req.headers["content-type"]);
			if (!isSupportedVoiceContentType(mimeType)) {
				this.writeJson(res, 415, { ok: false, error: `Unsupported voice content type: ${mimeType || "unknown"}` });
				return;
			}
			const buffer = await this.readBinaryBody(req, VOICE_BODY_LIMIT_BYTES);
			const includeAudio = isTruthy(url.searchParams.get("audio"));
			const target = url.searchParams.get("target")?.trim() || undefined;
			const result = await this.withTimeout(this.onVoiceTurn(buffer, mimeType, includeAudio, target));
			this.writeJson(res, 200, await this.createTurnPayload(result));
			return;
		}

		this.writeJson(res, 404, { ok: false, error: "Not found" });
	}

	private async handlePublicRoute(url: URL, res: ServerResponse) {
		if (url.pathname === "/" || url.pathname === "/app") {
			this.redirect(res, "/app/");
			return true;
		}

		if (url.pathname === "/app/" || url.pathname === "/app/index.html") {
			await this.serveStaticFile(join(REMOTE_APP_DIR, "index.html"), "text/html; charset=utf-8", res, "no-store");
			return true;
		}

		if (url.pathname === "/app/app.js") {
			await this.serveStaticFile(
				join(REMOTE_APP_DIR, "app.js"),
				"application/javascript; charset=utf-8",
				res,
				"no-store",
			);
			return true;
		}

		if (url.pathname === "/app/app.webmanifest") {
			await this.serveStaticFile(
				join(REMOTE_APP_DIR, "app.webmanifest"),
				"application/manifest+json; charset=utf-8",
				res,
				"no-store",
			);
			return true;
		}

		if (url.pathname === "/app/sw.js") {
			res.setHeader("Service-Worker-Allowed", "/app/");
			await this.serveStaticFile(
				join(REMOTE_APP_DIR, "sw.js"),
				"application/javascript; charset=utf-8",
				res,
				"no-store",
			);
			return true;
		}

		if (url.pathname === "/app/icon.svg") {
			await this.serveStaticFile(join(REMOTE_APP_DIR, "icon.svg"), "image/svg+xml", res, "public, max-age=86400");
			return true;
		}

		return false;
	}

	private isAuthorized(req: IncomingMessage, url: URL, allowQueryToken: boolean) {
		const token = this.state.authToken || "";
		if (!token) return true;
		if (isLocalRequest(req, url)) return true;
		const headerToken = getPrimaryHeaderValue(req.headers["x-pi-speak-token"]);
		if (headerToken === token) return true;
		const authHeader = getPrimaryHeaderValue(req.headers.authorization);
		if (authHeader === `Bearer ${token}`) return true;
		return allowQueryToken && url.searchParams.get("token") === token;
	}

	private checkRateLimit(req: IncomingMessage, url: URL, localRequest: boolean) {
		if (localRequest) return undefined;
		const key = `${req.socket.remoteAddress || "unknown"}:${this.extractPresentedToken(req) || "anon"}`;
		const now = Date.now();
		const bucket = this.rateLimitBuckets.get(key) || {
			windowStartedAt: now,
			control: 0,
			voice: 0,
		};
		if (now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
			bucket.windowStartedAt = now;
			bucket.control = 0;
			bucket.voice = 0;
		}
		const isVoice = req.method === "POST" && url.pathname === "/v1/turn/voice";
		if (isVoice) {
			if (bucket.voice >= RATE_LIMIT_VOICE) {
				return {
					ok: false,
					busy: true,
					error: "Voice rate limit exceeded. Retry shortly.",
					retryAfterMs: bucket.windowStartedAt + RATE_LIMIT_WINDOW_MS - now,
				};
			}
			bucket.voice += 1;
		} else {
			if (bucket.control >= RATE_LIMIT_CONTROL) {
				return {
					ok: false,
					busy: true,
					error: "Rate limit exceeded. Retry shortly.",
					retryAfterMs: bucket.windowStartedAt + RATE_LIMIT_WINDOW_MS - now,
				};
			}
			bucket.control += 1;
		}
		this.rateLimitBuckets.set(key, bucket);
		return undefined;
	}

	private extractPresentedToken(req: IncomingMessage) {
		return getPrimaryHeaderValue(req.headers["x-pi-speak-token"])
			|| getBearerToken(getPrimaryHeaderValue(req.headers.authorization));
	}

	private async createTurnPayload(result: RemoteTurnResult) {
		let audioUrl: string | undefined;
		if (result.audioPath) {
			const artifact = this.publishAudio(result.audioPath, result.audioMimeType || "audio/mpeg");
			audioUrl = `/v1/audio/${artifact.id}`;
		}

		return {
			ok: true,
			replyText: result.replyText,
			transcript: result.transcript,
			audioUrl,
			audioMimeType: result.audioMimeType,
			busy: result.busy,
			timings: result.timings,
			providers: result.providers,
			warnings: result.warnings,
		};
	}

	private publishAudio(filePath: string, mimeType: string) {
		const id = randomUUID();
		const artifact: AudioArtifact = {
			id,
			path: filePath,
			mimeType,
			expiresAt: Date.now() + AUDIO_TTL_MS,
		};
		this.audioArtifacts.set(id, artifact);
		return artifact;
	}

	private async handleAudioRequest(id: string, res: ServerResponse) {
		const artifact = this.audioArtifacts.get(id);
		if (!artifact || !existsSync(artifact.path)) {
			this.writeJson(res, 404, { ok: false, error: "Audio not found" });
			return;
		}

		res.statusCode = 200;
		res.setHeader("Content-Type", artifact.mimeType);
		res.setHeader("Cache-Control", "no-store");
		createReadStream(artifact.path).pipe(res);
	}

	private cleanupExpiredAudio() {
		const now = Date.now();
		for (const [id, artifact] of this.audioArtifacts.entries()) {
			if (artifact.expiresAt <= now) {
				this.audioArtifacts.delete(id);
				void rm(artifact.path, { force: true }).catch(() => {});
			}
		}
	}

	private async readTextBody(req: IncomingMessage, limitBytes: number) {
		const buffer = await this.readBinaryBody(req, limitBytes);
		return buffer.toString("utf8");
	}

	private async readBinaryBody(req: IncomingMessage, limitBytes: number) {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		for await (const chunk of req) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += buffer.length;
			if (totalBytes > limitBytes) {
				throw new RequestLimitError(`Request body exceeded ${limitBytes} bytes`, 413);
			}
			chunks.push(buffer);
		}
		return Buffer.concat(chunks);
	}

	private writeJson(res: ServerResponse, status: number, payload: unknown) {
		if (res.writableEnded) return;
		res.statusCode = status;
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.end(JSON.stringify(payload));
	}

	private async serveStaticFile(
		filePath: string,
		contentType: string,
		res: ServerResponse,
		cacheControl = "no-store",
	) {
		if (!existsSync(filePath)) {
			this.writeJson(res, 404, { ok: false, error: `Static asset not found: ${filePath}` });
			return;
		}
		res.statusCode = 200;
		res.setHeader("Content-Type", contentType);
		res.setHeader("Cache-Control", cacheControl);
		res.end(await readFile(filePath));
	}

	private redirect(res: ServerResponse, location: string) {
		res.statusCode = 302;
		res.setHeader("Location", location);
		res.end();
	}

	private applyCors(req: IncomingMessage, res: ServerResponse, url: URL) {
		const origin = getPrimaryHeaderValue(req.headers.origin);
		if (!origin) return;
		const allowed =
			this.allowedOrigins.includes(origin) ||
			(this.allowedOrigins.length === 0 && sameOrigin(origin, url));
		if (!allowed) return;
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Pi-Speak-Token");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	}

	private async withTimeout<T>(promise: Promise<T>) {
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new RequestLimitError("Request timed out", 504)), REQUEST_TIMEOUT_MS).unref?.();
		});
		return await Promise.race([promise, timeout]);
	}
}

class RequestLimitError extends Error {
	constructor(message: string, readonly statusCode: number) {
		super(message);
		this.name = "RequestLimitError";
	}
}

function parseJson<T>(text: string) {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function isTruthy(value: string | null) {
	if (!value) return false;
	return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function isLoopback(remoteAddress: string) {
	return remoteAddress === "::1" || remoteAddress === "127.0.0.1" || remoteAddress === "::ffff:127.0.0.1";
}

function isLocalRequest(req: IncomingMessage, url: URL) {
	return isLoopback(req.socket.remoteAddress || "") && isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname: string) {
	const normalized = (hostname || "").toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function resolveRemoteAppDir() {
	const parentCandidate = join(__dirname, "..", "web", "remote");
	if (existsSync(join(parentCandidate, "index.html"))) return parentCandidate;
	const localCandidate = join(__dirname, "web", "remote");
	if (existsSync(join(localCandidate, "index.html"))) return localCandidate;
	return parentCandidate;
}

function getErrorMessage(error: unknown) {
	if (error instanceof RequestLimitError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

function parseAllowedOrigins(value: string) {
	return value
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
}

function sameOrigin(origin: string, url: URL) {
	try {
		const parsed = new URL(origin);
		return parsed.host === url.host && parsed.protocol === url.protocol;
	} catch {
		return false;
	}
}

function getPrimaryHeaderValue(value: string | string[] | undefined) {
	if (Array.isArray(value)) return value[0];
	return value;
}

function getBearerToken(value?: string) {
	if (!value?.startsWith("Bearer ")) return "";
	return value.slice("Bearer ".length);
}

function isSupportedVoiceContentType(mimeType?: string) {
	const normalized = (mimeType || "").toLowerCase().split(";")[0].trim();
	return !!normalized && ALLOWED_VOICE_CONTENT_TYPES.includes(normalized);
}
