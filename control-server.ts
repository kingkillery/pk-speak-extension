import { createReadStream, existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type ControlServerState = {
	enabled: boolean;
	host?: string;
	port?: number;
	authToken?: string;
};

export type RemoteTurnResult = {
	replyText: string;
	audioPath?: string;
	audioMimeType?: string;
	transcript?: string;
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
	};
};

export type ControlServerOptions = {
	state: ControlServerState;
	onStateChange: (patch: Partial<ControlServerState>) => void;
	getStatus: () => ControlServerStatus;
	onMonoAction: (action: "on" | "off" | "status") => Promise<ControlActionResult> | ControlActionResult;
	onSpeakAction: (
		action: "on" | "off" | "stop" | "status" | "test" | "providers" | "provider" | "rewrite",
		value?: string,
	) => Promise<ControlActionResult> | ControlActionResult;
	onPhoneAction: (
		action: "on" | "off" | "status" | "code" | "unpair",
	) => Promise<ControlActionResult> | ControlActionResult;
	onTextTurn: (text: string, includeAudio: boolean) => Promise<RemoteTurnResult>;
	onVoiceTurn: (buffer: Buffer, mimeType: string | undefined, includeAudio: boolean) => Promise<RemoteTurnResult>;
};

type AudioArtifact = {
	id: string;
	path: string;
	mimeType: string;
	expiresAt: number;
};

const DEFAULT_HOST = process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0";
const DEFAULT_PORT = Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10);
const AUDIO_TTL_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_AUDIO_TTL_MS || "600000", 10);
const REMOTE_APP_DIR = resolveRemoteAppDir();

export class ControlServer {
	private server?: Server;
	private readonly onStateChange: (patch: Partial<ControlServerState>) => void;
	private readonly getStatus: () => ControlServerStatus;
	private readonly onMonoAction: ControlServerOptions["onMonoAction"];
	private readonly onSpeakAction: ControlServerOptions["onSpeakAction"];
	private readonly onPhoneAction: ControlServerOptions["onPhoneAction"];
	private readonly onTextTurn: ControlServerOptions["onTextTurn"];
	private readonly onVoiceTurn: ControlServerOptions["onVoiceTurn"];
	private state: ControlServerState;
	private readonly audioArtifacts = new Map<string, AudioArtifact>();

	constructor(options: ControlServerOptions) {
		this.state = {
			enabled: options.state.enabled,
			host: options.state.host || DEFAULT_HOST,
			port: options.state.port || DEFAULT_PORT,
			authToken: options.state.authToken || process.env.PI_SPEAK_HTTP_TOKEN || randomUUID(),
		};
		this.onStateChange = options.onStateChange;
		this.getStatus = options.getStatus;
		this.onMonoAction = options.onMonoAction;
		this.onSpeakAction = options.onSpeakAction;
		this.onPhoneAction = options.onPhoneAction;
		this.onTextTurn = options.onTextTurn;
		this.onVoiceTurn = options.onVoiceTurn;
	}

	getRuntimeState() {
		return {
			enabled: !!this.server,
			host: this.state.host || DEFAULT_HOST,
			port: this.state.port || DEFAULT_PORT,
			authToken: this.state.authToken || "",
		};
	}

	async start() {
		if (this.server) return this.getRuntimeState();
		const host = this.state.host || DEFAULT_HOST;
		const port = this.state.port || DEFAULT_PORT;
		const authToken = this.state.authToken || randomUUID();
		this.state = { enabled: true, host, port, authToken };

		this.server = createServer((req, res) => {
			void this.handleRequest(req, res).catch((error) => {
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

		this.onStateChange({ enabled: true, host, port, authToken });
		return this.getRuntimeState();
	}

	async stop() {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		this.onStateChange({ enabled: false });
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse) {
		this.cleanupExpiredAudio();
		this.applyCors(res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}

		const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
		if (req.method === "GET" && (await this.handlePublicRoute(url, res))) {
			return;
		}

		if (!this.isAuthorized(req, url)) {
			this.writeJson(res, 401, { ok: false, error: "Unauthorized" });
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

		if (req.method === "GET" && url.pathname.startsWith("/v1/audio/")) {
			const id = decodeURIComponent(url.pathname.slice("/v1/audio/".length));
			await this.handleAudioRequest(id, res);
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
			this.writeJson(res, 200, await this.createTurnPayload(await this.onTextTurn(text, includeAudio), url));
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/turn/text") {
			const body = await this.readTextBody(req);
			const payload = parseJson<Record<string, unknown>>(body);
			const text = typeof payload?.text === "string" ? payload.text : "";
			const includeAudio = !!payload?.audio;
			this.writeJson(res, 200, await this.createTurnPayload(await this.onTextTurn(text, includeAudio), url));
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/turn/voice") {
			const buffer = await this.readBinaryBody(req);
			const includeAudio = isTruthy(url.searchParams.get("audio"));
			const mimeType = req.headers["content-type"];
			const result = await this.onVoiceTurn(buffer, Array.isArray(mimeType) ? mimeType[0] : mimeType, includeAudio);
			this.writeJson(res, 200, await this.createTurnPayload(result, url));
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

	private isAuthorized(req: IncomingMessage, url: URL) {
		const token = this.state.authToken || "";
		if (!token) return true;
		if (isLocalRequest(req, url)) return true;
		const headerToken = req.headers["x-pi-speak-token"];
		if (typeof headerToken === "string" && headerToken === token) return true;
		const authHeader = req.headers.authorization;
		if (typeof authHeader === "string" && authHeader === `Bearer ${token}`) return true;
		return url.searchParams.get("token") === token;
	}

	private async createTurnPayload(result: RemoteTurnResult, url: URL) {
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

	private async readTextBody(req: IncomingMessage) {
		const buffer = await this.readBinaryBody(req);
		return buffer.toString("utf8");
	}

	private async readBinaryBody(req: IncomingMessage) {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

	private applyCors(res: ServerResponse) {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Pi-Speak-Token");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
	return (
		remoteAddress === "::1" ||
		remoteAddress === "127.0.0.1" ||
		remoteAddress === "::ffff:127.0.0.1"
	);
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
	if (error instanceof Error) return error.message;
	return String(error);
}
