import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import dgram, { type Socket as UdpSocket } from "node:dgram";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { hostname, networkInterfaces, platform } from "node:os";
import QRCode from "qrcode";
import Bonjour from "bonjour-service";
import { BusyError, type RemoteTurnSource, RemoteTurnResult } from "./remote-turn-manager.js";
import type { ExecutionTraceOutcome } from "./conversation-execution-trace.js";
import { readExecutionPlans, readExecutionTraces } from "./conversation-execution-trace.js";
import type { SessionDashboard, CompactRouteSlot } from "./session-routing.js";
import type { AgentDiscoverySnapshot } from "./agent-discovery.js";

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

export type SessionRenamePayload = {
	sessionPath: string;
	newName: string;
};

export type SessionAliasPayload = {
	sessionPath: string;
	alias: string;
};

export type SessionRemovePayload = {
	sessionPath: string;
};

export type RemoteSlashCommand = {
	name: string;
	description?: string;
	usage?: string;
	examples?: string[];
	source?: "extension" | "prompt" | "skill" | "builtin";
};

export type ControlServerStatus = {
	agent?: {
		provider: "pi" | "codex" | "gemini" | "gemini-live" | "elevenlabs";
		configuredProvider?: "pi" | "codex" | "gemini" | "gemini-live" | "elevenlabs";
		model?: string;
		capabilities: {
			textTurns: boolean;
			voiceTurns: boolean;
			audioReplies: boolean;
			routing: boolean;
			steering: boolean;
		};
	};
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
	discovery?: DiscoveryDiagnostics;
	summary?: {
		agentProvider?: string;
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

export type DiscoveryDiagnostics = {
	udpEnabled: boolean;
	udpPort: number;
	mdnsEnabled: boolean;
	mdnsService: string;
	lastError?: string;
};

export type WorkspaceEntry = {
	name: string;
	path: string;
	type: "directory";
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
	getSlashCommands?: () => RemoteSlashCommand[];
	onTextTurn: (
		text: string,
		includeAudio: boolean,
		target?: string,
		cwd?: string,
		mode?: "auto" | "live",
		agentProvider?: "pi" | "codex",
	) => Promise<RemoteTurnResult>;
	onVoiceTurn: (
		buffer: Buffer,
		mimeType: string | undefined,
		includeAudio: boolean,
		target?: string,
		cwd?: string,
		mode?: "auto" | "live",
		agentProvider?: "pi" | "codex",
	) => Promise<RemoteTurnResult>;
	onTurnCancel?: () => Promise<ControlActionResult> | ControlActionResult;
	getSessionDashboard?: () => SessionDashboard;
	getCompactRouteSlots?: () => CompactRouteSlot[];
	onSessionRename?: (body: SessionRenamePayload) => Promise<ControlActionResult> | ControlActionResult;
	onSessionAlias?: (body: SessionAliasPayload) => Promise<ControlActionResult> | ControlActionResult;
	onSessionRemove?: (body: SessionRemovePayload) => Promise<ControlActionResult> | ControlActionResult;
	getDiscoveredAgents?: () => string[] | AgentDiscoverySnapshot;
	tailSessionEvents?: (sinceOffset: number) => { events: unknown[]; nextOffset: number };
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

const MONO_ACTIONS = new Set(["on", "off", "status"]);
const PHONE_ACTIONS = new Set(["on", "off", "status", "code", "unpair"]);
const SPEAK_READ_ACTIONS = new Set(["status", "providers"]);
const SPEAK_WRITE_ACTIONS = new Set(["on", "off", "stop", "test", "provider", "rewrite"]);

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
const TRUST_TAILSCALE_LOCAL = isTruthy(process.env.PI_SPEAK_TRUST_TAILSCALE_LOCAL || "false");
const TRUSTED_TAILSCALE_IPS = new Set(
	(process.env.PI_SPEAK_TRUSTED_TAILSCALE_IPS || "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean),
);
const REMOTE_APP_DIR = resolveRemoteAppDir();
const ANDROID_APK_PATH = resolveAndroidApkPath();
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
		agentProvider: typeof status.agent?.provider === "string" ? status.agent.provider : undefined,
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
	private discoverySocket?: UdpSocket;
	private bonjour?: Bonjour;
	private bonjourService?: unknown;
	private cleanupTimer?: NodeJS.Timeout;
	private readonly onStateChange: (patch: Partial<ControlServerState>) => void;
	private readonly getStatus: () => ControlServerStatus;
	private readonly getDiagnostics: () => ControlServerDiagnostics;
	private readonly getRoutingStatus: ControlServerOptions["getRoutingStatus"];
	private readonly setRoutingTarget: ControlServerOptions["setRoutingTarget"];
	private readonly onMonoAction: ControlServerOptions["onMonoAction"];
	private readonly onSpeakAction: ControlServerOptions["onSpeakAction"];
	private readonly onPhoneAction: ControlServerOptions["onPhoneAction"];
	private readonly getSlashCommands: NonNullable<ControlServerOptions["getSlashCommands"]>;
	private readonly onTextTurn: ControlServerOptions["onTextTurn"];
	private readonly onVoiceTurn: ControlServerOptions["onVoiceTurn"];
	private readonly onTurnCancel?: ControlServerOptions["onTurnCancel"];
	private readonly getSessionDashboard?: ControlServerOptions["getSessionDashboard"];
	private readonly getCompactRouteSlots?: ControlServerOptions["getCompactRouteSlots"];
	private readonly onSessionRename?: ControlServerOptions["onSessionRename"];
	private readonly onSessionAlias?: ControlServerOptions["onSessionAlias"];
	private readonly onSessionRemove?: ControlServerOptions["onSessionRemove"];
	private readonly getDiscoveredAgents?: ControlServerOptions["getDiscoveredAgents"];
	private readonly tailSessionEvents?: ControlServerOptions["tailSessionEvents"];
	private readonly state: ControlServerState;
	private readonly audioArtifacts = new Map<string, AudioArtifact>();
	private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();
	private readonly allowedOrigins = parseAllowedOrigins(process.env.PI_SPEAK_HTTP_ALLOWED_ORIGINS || "");
	private readonly discoveryDiagnostics: DiscoveryDiagnostics = {
		udpEnabled: false,
		udpPort: getDiscoveryPort(),
		mdnsEnabled: false,
		mdnsService: "_pispeak._tcp.local",
	};

	constructor(options: ControlServerOptions) {
		this.state = {
			enabled: options.state.enabled,
			host: options.state.host ?? DEFAULT_HOST,
			port: options.state.port ?? DEFAULT_PORT,
			authToken: options.state.authToken || process.env.PI_SPEAK_HTTP_TOKEN || getOrCreateInstallAuthToken(),
		};
		this.onStateChange = options.onStateChange;
		this.getStatus = options.getStatus;
		this.getDiagnostics = options.getDiagnostics;
		this.getRoutingStatus = options.getRoutingStatus;
		this.setRoutingTarget = options.setRoutingTarget;
		this.onMonoAction = options.onMonoAction;
		this.onSpeakAction = options.onSpeakAction;
		this.onPhoneAction = options.onPhoneAction;
		this.getSlashCommands = options.getSlashCommands || (() => []);
		this.onTextTurn = options.onTextTurn;
		this.onVoiceTurn = options.onVoiceTurn;
		this.onTurnCancel = options.onTurnCancel;
		this.getSessionDashboard = options.getSessionDashboard;
		this.getCompactRouteSlots = options.getCompactRouteSlots;
		this.onSessionRename = options.onSessionRename;
		this.onSessionAlias = options.onSessionAlias;
		this.onSessionRemove = options.onSessionRemove;
		this.getDiscoveredAgents = options.getDiscoveredAgents;
		this.tailSessionEvents = options.tailSessionEvents;
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
		const authToken = this.state.authToken || process.env.PI_SPEAK_HTTP_TOKEN || getOrCreateInstallAuthToken();
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
				this.writeJson(res, 502, { ok: false, error: getErrorMessage(error) });
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
		await this.startDiscoveryResponder().catch((error) => {
			this.discoveryDiagnostics.udpEnabled = false;
			this.discoveryDiagnostics.lastError = `UDP discovery startup failed: ${getErrorMessage(error)}`;
		});
		this.startMdnsAdvertisement();
		return this.getRuntimeState();
	}

	async stop() {
		if (!this.server) return;
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}
		if (this.discoverySocket) {
			this.discoverySocket.close();
			this.discoverySocket = undefined;
		}
		await this.stopMdnsAdvertisement();
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		this.onStateChange({ enabled: false });
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		this.applyCors(req, res, url);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}

		if (req.method === "GET" && (await this.handlePublicRoute(req, url, res))) {
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
					discovery: { ...this.discoveryDiagnostics },
				},
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/execution-traces") {
			const traces = readExecutionTraces({
				limit: parsePositiveInt(url.searchParams.get("limit"), 50),
				source: normalizeRemoteTurnSource(url.searchParams.get("source")),
				outcome: normalizeExecutionTraceOutcome(url.searchParams.get("outcome")),
				backend: normalizeBackend(url.searchParams.get("backend")),
				dispatch: normalizeDispatchFilter(url.searchParams.get("dispatch")),
			});
			this.writeJson(res, 200, {
				ok: true,
				enabled: traces.enabled,
				path: traces.path,
				traces: traces.traces,
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/execution-plans") {
			const plans = readExecutionPlans({
				limit: parsePositiveInt(url.searchParams.get("limit"), 50),
				source: normalizeRemoteTurnSource(url.searchParams.get("source")),
				outcome: normalizeExecutionTraceOutcome(url.searchParams.get("outcome")),
				backend: normalizeBackend(url.searchParams.get("backend")),
				dispatch: normalizeDispatchFilter(url.searchParams.get("dispatch")),
			});
			this.writeJson(res, 200, {
				ok: true,
				enabled: plans.enabled,
				path: plans.path,
				plans: plans.plans,
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

		if (req.method === "GET" && url.pathname === "/v1/commands") {
			this.writeJson(res, 200, {
				ok: true,
				commands: this.getSlashCommands(),
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/workspace") {
			this.writeJson(res, 200, {
				ok: true,
				workspace: listWorkspaceDirectory(url.searchParams.get("path") || undefined),
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/route") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			if (!payload) {
				this.writeJson(res, 400, { ok: false, error: "Invalid JSON body." });
				return;
			}
			const target = typeof payload?.target === "string" ? payload.target : "";
			const result = await this.setRoutingTarget(target.trim() || undefined);
			this.writeJson(res, result.ok ? 200 : 400, {
				ok: result.ok,
				message: result.message,
				route: this.getRoutingStatus(),
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/sessions") {
			if (!this.getSessionDashboard) {
				this.writeJson(res, 501, { ok: false, error: "Session dashboard is not available on this gateway." });
				return;
			}
			this.writeJson(res, 200, { ok: true, dashboard: this.getSessionDashboard() });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/sessions/slots") {
			if (!this.getCompactRouteSlots) {
				this.writeJson(res, 501, { ok: false, error: "Route slots are not available on this gateway." });
				return;
			}
			this.writeJson(res, 200, { ok: true, slots: this.getCompactRouteSlots() });
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/sessions/rename") {
			if (!this.onSessionRename) {
				this.writeJson(res, 501, { ok: false, error: "Session rename is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			if (!payload || typeof payload.sessionPath !== "string" || typeof payload.newName !== "string") {
				this.writeJson(res, 400, { ok: false, error: "Invalid payload: sessionPath and newName are required strings." });
				return;
			}
			const result = await this.onSessionRename({ sessionPath: payload.sessionPath, newName: payload.newName });
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/sessions/alias") {
			if (!this.onSessionAlias) {
				this.writeJson(res, 501, { ok: false, error: "Session alias is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			if (!payload || typeof payload.sessionPath !== "string" || typeof payload.alias !== "string") {
				this.writeJson(res, 400, { ok: false, error: "Invalid payload: sessionPath and alias are required strings." });
				return;
			}
			const result = await this.onSessionAlias({ sessionPath: payload.sessionPath, alias: payload.alias });
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/sessions/remove") {
			if (!this.onSessionRemove) {
				this.writeJson(res, 501, { ok: false, error: "Session remove is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			if (!payload || typeof payload.sessionPath !== "string") {
				this.writeJson(res, 400, { ok: false, error: "Invalid payload: sessionPath is a required string." });
				return;
			}
			const result = await this.onSessionRemove({ sessionPath: payload.sessionPath });
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/agents") {
			if (!this.getDiscoveredAgents) {
				this.writeJson(res, 501, { ok: false, error: "Agent discovery is not available on this gateway." });
				return;
			}
			const discovered = this.getDiscoveredAgents();
			if (Array.isArray(discovered)) {
				this.writeJson(res, 200, { ok: true, agents: discovered, running: [], recent: [] });
				return;
			}
			this.writeJson(res, 200, {
				ok: true,
				agents: discovered.targets,
				running: discovered.running,
				recent: discovered.recent,
				generatedAt: discovered.generatedAt,
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/events") {
			if (!this.tailSessionEvents) {
				this.writeJson(res, 501, { ok: false, error: "Event stream is not available on this gateway." });
				return;
			}
			if (!this.isAuthorized(req, url, true)) {
				this.writeJson(res, 401, { ok: false, error: "Unauthorized" });
				return;
			}
			await this.handleEventStream(req, url, res);
			return;
		}

		if (await this.handleMonoRoute(req, res, url)) return;
		if (await this.handlePhoneRoute(req, res, url)) return;
		if (await this.handleSpeakRoute(req, res, url)) return;

		if (req.method === "POST" && url.pathname === "/v1/turn/cancel") {
			if (!this.onTurnCancel) {
				this.writeJson(res, 501, { ok: false, error: "Turn cancellation is not available on this gateway." });
				return;
			}
			const result = await this.onTurnCancel();
			this.writeJson(res, result.ok ? 200 : 400, { ok: result.ok, message: result.message });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/turn/text") {
			const text = url.searchParams.get("text") || "";
			const includeAudio = isTruthy(url.searchParams.get("audio"));
			const mode = parseRemoteTurnMode(url.searchParams.get("mode"));
			const target = url.searchParams.get("target")?.trim() || undefined;
			const cwd = getLaunchCwdFromUrl(url);
			const agentProvider = parseAgentProviderOverride(url.searchParams.get("agentProvider"));
			const result = await this.withTimeout(this.onTextTurn(text, includeAudio, target, cwd, mode, agentProvider));
			this.writeJson(res, 200, await this.createTurnPayload(result));
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/turn/text") {
			const body = await this.readTextBody(req, TEXT_BODY_LIMIT_BYTES);
			const payload = parseJson<Record<string, unknown>>(body);
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				this.writeJson(res, 400, { ok: false, error: "Invalid JSON body." });
				return;
			}
			if (typeof payload.text !== "string") {
				this.writeJson(res, 400, { ok: false, error: "Invalid payload: text is required." });
				return;
			}
			const text = typeof payload?.text === "string" ? payload.text : "";
			const includeAudio = !!payload?.audio;
			const mode = parseRemoteTurnMode(typeof payload?.mode === "string" ? payload.mode : undefined);
			const target = typeof payload?.target === "string" ? payload.target.trim() || undefined : undefined;
			const cwd = getLaunchCwdFromPayload(payload);
			const agentProvider = parseAgentProviderOverride(typeof payload?.agentProvider === "string" ? payload.agentProvider : undefined);
			const result = await this.withTimeout(this.onTextTurn(text, includeAudio, target, cwd, mode, agentProvider));
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
			const mode = parseRemoteTurnMode(url.searchParams.get("mode"));
			const target = url.searchParams.get("target")?.trim() || undefined;
			const cwd = getLaunchCwdFromUrl(url);
			const agentProvider = parseAgentProviderOverride(url.searchParams.get("agentProvider"));
			const result = await this.withTimeout(this.onVoiceTurn(buffer, mimeType, includeAudio, target, cwd, mode, agentProvider));
			this.writeJson(res, 200, await this.createTurnPayload(result));
			return;
		}

		this.writeJson(res, 404, { ok: false, error: "Not found" });
	}

	private async handlePublicRoute(req: IncomingMessage, url: URL, res: ServerResponse) {
		if (url.pathname === "/health") {
			this.writeJson(res, 200, {
				ok: true,
				app: "pi-speak",
				authRequired: !!this.state.authToken,
			});
			return true;
		}

		if (url.pathname === "/.well-known/pi-speak" || url.pathname === "/v1/discovery") {
			this.writeJson(res, 200, this.buildDiscoveryDescriptor(req, url));
			return true;
		}

		if (url.pathname === "/" || url.pathname === "/app") {
			this.redirect(res, "/app/");
			return true;
		}

		if (url.pathname === "/setup" || url.pathname === "/setup/") {
			await this.handleSetupPage(req, url, res);
			return true;
		}

		if (url.pathname === "/download" || url.pathname === "/download/") {
			this.redirect(res, "/download/pi-speak.apk");
			return true;
		}

		if (url.pathname === "/download/pi-speak.apk") {
			await this.serveStaticFile(ANDROID_APK_PATH, "application/vnd.android.package-archive", res, "no-store");
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

	private startMdnsAdvertisement() {
		if (this.bonjour || isTruthy(process.env.PI_SPEAK_DISABLE_MDNS || "false")) return;
		const port = this.state.port ?? DEFAULT_PORT;
		try {
			this.bonjour = new Bonjour(undefined, (error: unknown) => {
				this.discoveryDiagnostics.lastError = `mDNS error: ${getErrorMessage(error)}`;
			});
			this.bonjourService = this.bonjour.publish({
				name: getMdnsServiceInstanceName(port),
				type: "pispeak",
				protocol: "tcp",
				port,
				disableIPv6: true,
				txt: {
					app: "pi-speak",
					pkg: "pi-speak-pk",
					version: process.env.npm_package_version || "0.0.0",
					api: "1",
					auth: "required",
					pairing: "setup-v1",
					path: "/.well-known/pi-speak",
					caps: "text,voice,audio,routing,pwa,android,progress,cancel,session-dashboard,route-slots,session-mutations,agent-discovery,event-stream",
				},
			});
			this.discoveryDiagnostics.mdnsEnabled = true;
		} catch (error) {
			this.discoveryDiagnostics.mdnsEnabled = false;
			this.discoveryDiagnostics.lastError = `mDNS startup failed: ${getErrorMessage(error)}`;
		}
	}

	private async stopMdnsAdvertisement() {
		const bonjour = this.bonjour;
		this.bonjour = undefined;
		this.bonjourService = undefined;
		this.discoveryDiagnostics.mdnsEnabled = false;
		if (!bonjour) return;
		await new Promise<void>((resolve) => {
			try {
				bonjour.unpublishAll(() => {
					bonjour.destroy(() => resolve());
				});
			} catch {
				resolve();
			}
		});
	}

	private async startDiscoveryResponder() {
		this.discoveryDiagnostics.udpPort = getDiscoveryPort();
		if (this.discoverySocket || isTruthy(process.env.PI_SPEAK_DISABLE_UDP_DISCOVERY || "false")) return;
		const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
		this.discoverySocket = socket;
		socket.on("error", (error) => {
			this.discoveryDiagnostics.udpEnabled = false;
			this.discoveryDiagnostics.lastError = `UDP discovery error: ${getErrorMessage(error)}`;
		});
		socket.on("message", (message, remote) => {
			let payload: any;
			try {
				payload = JSON.parse(message.toString("utf8"));
			} catch {
				return;
			}
			if (payload?.type !== "pi-speak.discover" || payload?.version !== 1) return;
			const response = Buffer.from(JSON.stringify({
				type: "pi-speak.announce",
				version: 1,
				nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
				id: getStableServerId(),
				name: `Pi Speak on ${hostname() || "machine"}`,
				httpPort: this.state.port ?? DEFAULT_PORT,
				baseUrls: getReachableBaseUrls(this.state.port ?? DEFAULT_PORT),
				authRequired: !!this.state.authToken,
				descriptorPath: "/.well-known/pi-speak",
			}));
			socket.send(response, remote.port, remote.address);
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.bind(getDiscoveryPort(), () => {
				socket.off("error", reject);
				try {
					socket.setBroadcast(true);
				} catch {}
				this.discoveryDiagnostics.udpEnabled = true;
				resolve();
			});
		});
	}

	private buildDiscoveryDescriptor(req: IncomingMessage, url: URL) {
		const status = this.getStatus();
		const baseUrl = getRequestBaseUrl(req, url);
		return {
			schema: "pi-speak.discovery.v1",
			app: "pi-speak",
			package: "pi-speak-pk",
			version: process.env.npm_package_version || "0.0.0",
			serverId: getStableServerId(),
			name: `Pi Speak on ${hostname() || "machine"}`,
			authRequired: !!this.state.authToken,
			pairingRequired: true,
			pairingMethods: ["setup-qr"],
			pairing: {
				required: true,
				methods: ["setup-qr", "native-deep-link"],
				setupPath: "/setup",
				deepLinkScheme: "pi-speak://setup",
				tokenDelivery: "setup-qr-only",
				instructions: "Run /pk-remote on the computer and scan the setup QR. Discovery never exposes the token.",
			},
			security: {
				publicDiscoveryIncludesToken: false,
				tokenDelivery: "setup-qr-only",
			},
			baseUrls: [...new Set([baseUrl, ...getReachableBaseUrls(this.state.port ?? DEFAULT_PORT)])],
			endpoints: {
				app: "/app/",
				setup: "/setup",
				health: "/health",
				status: "/v1/status",
				diagnostics: "/v1/diagnostics",
				textTurn: "/v1/turn/text",
				voiceTurn: "/v1/turn/voice",
				cancelTurn: "/v1/turn/cancel",
				route: "/v1/route",
				workspace: "/v1/workspace",
				sessions: "/v1/sessions",
				slots: "/v1/sessions/slots",
				agents: "/v1/agents",
				events: "/v1/events",
			},
			capabilities: [
				"text-turn",
				"voice-turn",
				"audio-reply",
				"routing",
				"slash-commands",
				"workspace-browse",
				"turn-cancel",
				"progress-events",
				"pwa",
				"android-apk",
				"session-dashboard",
				"route-slots",
				"session-mutations",
				"agent-discovery",
				"event-stream",
			],
			agent: status.agent
				? {
					provider: status.agent.provider,
					configuredProvider: status.agent.configuredProvider,
					capabilities: status.agent.capabilities,
				}
				: undefined,
			commands: this.getSlashCommands().map((command) => ({
				name: command.name,
				description: command.description,
				usage: command.usage,
				source: command.source,
			})),
		};
	}

	private async handleSetupPage(req: IncomingMessage, url: URL, res: ServerResponse) {
		const baseUrl = getRequestBaseUrl(req, url);
		const token = url.searchParams.get("token") || "";
		const status = this.getStatus();
		const profileName = url.searchParams.get("profile_name")
			|| status.remote.currentSession
			|| "Pi Speak";
		const setupParams = new URLSearchParams({
			base_url: baseUrl,
			machine_id: url.hostname || "pi-speak",
			profile_name: profileName,
			connection_mode: isTailscaleHostname(url.hostname) ? "tailscale" : "manual",
			workspace_root: getWorkspaceRoot(),
			workspace_path: getDefaultWorkspacePath(),
		});
		if (token) {
			setupParams.set("token", token);
		}
		const defaultTarget = status.remote.defaultTarget || status.remote.currentSession || "";
		if (defaultTarget) {
			setupParams.set("default_target", defaultTarget);
		}
		const agentProvider = status.agent?.provider;
		if (agentProvider === "pi"
			|| agentProvider === "codex"
			|| agentProvider === "elevenlabs"
			|| agentProvider === "gemini"
			|| agentProvider === "gemini-live") {
			setupParams.set("agent_provider", agentProvider);
		}
		const appSetupUrl = `pi-speak://setup?${setupParams.toString()}`;
		const apkUrl = new URL("/download/pi-speak.apk", baseUrl).toString();
		const browserUrl = new URL(`/app/${token ? `?token=${encodeURIComponent(token)}` : ""}`, baseUrl).toString();
		const [setupQrSvg, apkQrSvg] = await Promise.all([
			QRCode.toString(appSetupUrl, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 240 }),
			QRCode.toString(apkUrl, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 240 }),
		]);

		res.statusCode = 200;
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		res.end(renderSetupHtml({
			appSetupUrl,
			apkUrl,
			baseUrl,
			browserUrl,
			profileName,
			setupQrSvg,
			apkQrSvg,
			status,
			apkAvailable: existsSync(ANDROID_APK_PATH),
		}));
	}

	private async handleMonoRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
		if (!url.pathname.startsWith("/v1/mono/")) return false;
		const action = decodeURIComponent(url.pathname.slice("/v1/mono/".length));
		if (!MONO_ACTIONS.has(action)) return false;
		if (action === "status") {
			if (req.method !== "GET") {
				this.writeMethodNotAllowed(res, ["GET"]);
				return true;
			}
		} else if (req.method !== "POST") {
			this.writeMethodNotAllowed(res, ["POST"]);
			return true;
		}
		this.writeJson(res, 200, await this.onMonoAction(action as "on" | "off" | "status"));
		return true;
	}

	private async handlePhoneRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
		if (!url.pathname.startsWith("/v1/phone/")) return false;
		const action = decodeURIComponent(url.pathname.slice("/v1/phone/".length));
		if (!PHONE_ACTIONS.has(action)) return false;
		if (action === "status") {
			if (req.method !== "GET") {
				this.writeMethodNotAllowed(res, ["GET"]);
				return true;
			}
		} else if (req.method !== "POST") {
			this.writeMethodNotAllowed(res, ["POST"]);
			return true;
		}
		this.writeJson(res, 200, await this.onPhoneAction(action as "on" | "off" | "status" | "code" | "unpair"));
		return true;
	}

	private async handleSpeakRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
		if (url.pathname === "/v1/speak/providers") {
			if (req.method !== "GET") {
				this.writeMethodNotAllowed(res, ["GET"]);
				return true;
			}
			this.writeJson(res, 200, await this.onSpeakAction("providers"));
			return true;
		}

		if (url.pathname.startsWith("/v1/speak/provider/")) {
			if (req.method !== "POST") {
				this.writeMethodNotAllowed(res, ["POST"]);
				return true;
			}
			const value = decodeURIComponent(url.pathname.slice("/v1/speak/provider/".length));
			this.writeJson(res, 200, await this.onSpeakAction("provider", value));
			return true;
		}

		if (url.pathname.startsWith("/v1/speak/rewrite/")) {
			if (req.method !== "POST") {
				this.writeMethodNotAllowed(res, ["POST"]);
				return true;
			}
			const value = decodeURIComponent(url.pathname.slice("/v1/speak/rewrite/".length));
			this.writeJson(res, 200, await this.onSpeakAction("rewrite", value));
			return true;
		}

		if (!url.pathname.startsWith("/v1/speak/")) return false;
		const action = decodeURIComponent(url.pathname.slice("/v1/speak/".length));
		if (SPEAK_READ_ACTIONS.has(action)) {
			if (req.method !== "GET") {
				this.writeMethodNotAllowed(res, ["GET"]);
				return true;
			}
			this.writeJson(res, 200, await this.onSpeakAction(action as "status" | "providers"));
			return true;
		}
		if (SPEAK_WRITE_ACTIONS.has(action)) {
			if (req.method !== "POST") {
				this.writeMethodNotAllowed(res, ["POST"]);
				return true;
			}
			this.writeJson(res, 200, await this.onSpeakAction(action as "on" | "off" | "stop" | "test"));
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
			reducer: result.reducer,
			execution: result.execution,
			audioUrl,
			audioMimeType: result.audioMimeType,
			busy: result.busy,
			timings: result.timings,
			providers: result.providers,
			warnings: result.warnings,
			progress: result.progress,
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

	private async readJsonObject(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown> | undefined> {
		const body = await this.readTextBody(req, limitBytes);
		const payload = parseJson<Record<string, unknown>>(body);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		return payload;
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

	private writeMethodNotAllowed(res: ServerResponse, allowedMethods: string[]) {
		res.setHeader("Allow", allowedMethods.join(", "));
		this.writeJson(res, 405, { ok: false, error: `Method not allowed. Use ${allowedMethods.join(" or ")}.` });
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

	private async handleEventStream(req: IncomingMessage, url: URL, res: ServerResponse) {
		const sinceOffset = parseNonNegativeInt(url.searchParams.get("since"), 0);
		let offset = sinceOffset;

		res.statusCode = 200;
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");
		res.setHeader("Connection", "keep-alive");
		res.write(":ok\n\n");

		const sendEvents = () => {
			if (res.writableEnded || !this.tailSessionEvents) return;
			try {
				const batch = this.tailSessionEvents(offset);
				if (batch.events.length > 0) {
					for (const event of batch.events) {
						res.write(`data: ${JSON.stringify(event)}\n\n`);
					}
					offset = batch.nextOffset;
				}
			} catch (error) {
				res.write(`event: error\ndata: ${JSON.stringify({ message: getErrorMessage(error) })}\n\n`);
			}
		};

		sendEvents();
		const pollTimer = setInterval(sendEvents, 500);
		const keepAliveTimer = setInterval(() => {
			if (!res.writableEnded) res.write(":keep-alive\n\n");
		}, 15000);

		req.on("close", () => {
			clearInterval(pollTimer);
			clearInterval(keepAliveTimer);
		});
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

function getDiscoveryPort() {
	return Number.parseInt(process.env.PI_SPEAK_DISCOVERY_PORT || "8768", 10);
}

function getMdnsServiceInstanceName(port: number) {
	const host = hostname() || "machine";
	const serverId = getStableServerId().slice(0, 8);
	return `Pi Speak on ${host} ${serverId} ${port}`;
}

function parseRemoteTurnMode(value: string | null | undefined) {
	const normalized = (value || "").trim().toLowerCase();
	return normalized === "live" ? "live" : "auto";
}

function parseAgentProviderOverride(value: string | null | undefined) {
	const normalized = (value || "").trim().toLowerCase();
	if (normalized === "pi" || normalized === "codex") return normalized;
	return undefined;
}

function isTruthy(value: string | null) {
	if (!value) return false;
	return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function isLoopback(remoteAddress: string) {
	return remoteAddress === "::1" || remoteAddress === "127.0.0.1" || remoteAddress === "::ffff:127.0.0.1";
}

function normalizeRemoteAddress(address: string) {
	return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isTailscaleIp(remoteAddress: string) {
	// Tailscale uses the CGNAT range 100.64.0.0/10
	const parts = remoteAddress.split(".");
	if (parts.length !== 4) return false;
	const first = parseInt(parts[0], 10);
	const second = parseInt(parts[1], 10);
	return first === 100 && second >= 64 && second <= 127;
}

function isLocalRequest(req: IncomingMessage, url: URL) {
	const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
	const hostname = url.hostname;
	// Pure loopback — require both remote address and Host to be loopback
	if (isLoopback(remoteAddress) && isLoopbackHost(hostname)) return true;
	// Tailscale mesh — only if explicitly enabled and IP is in allowlist
	if (TRUST_TAILSCALE_LOCAL && TRUSTED_TAILSCALE_IPS.has(remoteAddress)) return true;
	return false;
}

function isLoopbackHost(hostname: string) {
	const normalized = (hostname || "").toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function resolveRemoteAppDir() {
	const parentCandidate = join(import.meta.dirname, "..", "web", "remote");
	if (existsSync(join(parentCandidate, "index.html"))) return parentCandidate;
	const localCandidate = join(import.meta.dirname, "web", "remote");
	if (existsSync(join(localCandidate, "index.html"))) return localCandidate;
	return parentCandidate;
}

function resolveAndroidApkPath() {
	const parentCandidate = join(import.meta.dirname, "..", "android-app", ".build-outputs", "app-debug.apk");
	if (existsSync(parentCandidate)) return parentCandidate;
	const localCandidate = join(import.meta.dirname, "android-app", ".build-outputs", "app-debug.apk");
	if (existsSync(localCandidate)) return localCandidate;
	return parentCandidate;
}

function getRequestBaseUrl(req: IncomingMessage, url: URL) {
	const forwardedProto = getPrimaryHeaderValue(req.headers["x-forwarded-proto"]);
	const protocol = forwardedProto || url.protocol.replace(":", "") || "http";
	return `${protocol}://${req.headers.host || url.host}/`;
}

function isTailscaleHostname(hostname: string) {
	const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
	return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function renderSetupHtml({
	appSetupUrl,
	apkUrl,
	baseUrl,
	browserUrl,
	profileName,
	setupQrSvg,
	apkQrSvg,
	status,
	apkAvailable,
}: {
	appSetupUrl: string;
	apkUrl: string;
	baseUrl: string;
	browserUrl: string;
	profileName: string;
	setupQrSvg: string;
	apkQrSvg: string;
	status: ControlServerStatus;
	apkAvailable: boolean;
}) {
	const queue = status.remote.enabled ? "online" : "offline";
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi Speak Phone Setup</title>
<style>
:root { color-scheme: light; font-family: Segoe UI, Arial, sans-serif; color: #182033; background: #f4f7fb; }
body { margin: 0; }
main { max-width: 980px; margin: 0 auto; padding: 28px; }
.hero { margin-bottom: 18px; }
h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: 0; }
p { line-height: 1.45; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.panel { background: #fff; border: 1px solid #d9e1ec; border-radius: 8px; padding: 18px; box-shadow: 0 10px 28px rgba(17, 24, 39, 0.08); }
.qr { display: flex; justify-content: center; margin: 14px 0; }
.meta { font-size: 14px; color: #526173; overflow-wrap: anywhere; }
.status { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 4px; }
.pill { background: #e9eef6; color: #253246; border: 1px solid #d3dce8; border-radius: 999px; padding: 6px 10px; font-size: 13px; }
a.button { display: inline-block; margin-top: 8px; background: #174b7a; color: white; text-decoration: none; border-radius: 6px; padding: 10px 12px; font-weight: 700; }
code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
</style>
</head>
<body>
<main>
<section class="hero">
<h1>Pair Pi Speak</h1>
<p>Install the Android app, then scan the setup QR from this computer. The phone saves the gateway, token, target session, and workspace; no IP address or API key entry is needed.</p>
<div class="status">
<span class="pill">Gateway: ${escapeHtml(queue)}</span>
<span class="pill">Profile: ${escapeHtml(profileName)}</span>
<span class="pill">Target: ${escapeHtml(status.remote.defaultTarget || status.remote.currentSession || "current session")}</span>
</div>
</section>
<section class="grid">
<article class="panel">
<h2>1. Install Android app</h2>
${apkAvailable ? `<div class="qr">${apkQrSvg}</div><p class="meta"><a class="button" href="${escapeHtml(apkUrl)}">Download APK</a></p><p class="meta"><code>${escapeHtml(apkUrl)}</code></p>` : `<p class="meta">APK is not bundled in this install. Build it with the Android project, then publish the package again.</p>`}
</article>
<article class="panel">
<h2>2. Pair this computer</h2>
<div class="qr">${setupQrSvg}</div>
<p class="meta"><a class="button" href="${escapeHtml(appSetupUrl)}">Open setup link</a></p>
<p class="meta">This QR is the credential handoff. LAN and Tailscale discovery can find the gateway later, but public discovery never includes the token.</p>
<p class="meta"><strong>Endpoint:</strong> <code>${escapeHtml(baseUrl)}</code></p>
<p class="meta"><strong>Web fallback:</strong> <a href="${escapeHtml(browserUrl)}">${escapeHtml(browserUrl)}</a></p>
</article>
</section>
</main>
</body>
</html>`;
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
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

function getLaunchCwdFromPayload(payload: Record<string, unknown> | undefined) {
	const value = typeof payload?.cwd === "string"
		? payload.cwd
		: typeof payload?.workspacePath === "string"
			? payload.workspacePath
			: "";
	return value.trim() || undefined;
}

function getLaunchCwdFromUrl(url: URL) {
	return (url.searchParams.get("cwd") || url.searchParams.get("workspacePath") || "").trim() || undefined;
}

function getWorkspaceRoot() {
	return process.env.PI_SPEAK_WORKSPACE_ROOT?.trim()
		|| (platform() === "win32" ? parse(process.cwd()).root || "C:\\" : "/");
}

function getDefaultWorkspacePath() {
	return process.env.AGENT_CWD?.trim()
		|| process.env.AGENT_WORKSPACE?.trim()
		|| process.cwd();
}

function listWorkspaceDirectory(requestedPath?: string) {
	const root = resolve(getWorkspaceRoot());
	const requested = resolve(requestedPath?.trim() || root);
	const currentPath = isPathInsideRoot(requested, root) ? requested : root;
	const current = safeStatDirectory(currentPath) ? currentPath : root;
	const entries: WorkspaceEntry[] = [];
	try {
		for (const dirent of readdirSync(current, { withFileTypes: true })) {
			if (!dirent.isDirectory()) continue;
			if (dirent.name === "$RECYCLE.BIN" || dirent.name === "System Volume Information") continue;
			const childPath = join(current, dirent.name);
			entries.push({ name: dirent.name, path: childPath, type: "directory" });
		}
	} catch {}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	const parent = current !== root ? dirname(current) : undefined;
	return {
		root,
		current,
		parent: parent && isPathInsideRoot(parent, root) ? parent : undefined,
		defaultPath: getDefaultWorkspacePath(),
		entries,
	};
}

function getOrCreateInstallAuthToken() {
	const tokenFile = getInstallAuthTokenPath();
	try {
		const existing = readFileSync(tokenFile, "utf8").trim();
		if (existing.length >= 24) return existing;
	} catch {
		// Generate below.
	}
	const token = randomBytes(32).toString("base64url");
	try {
		mkdirSync(dirname(tokenFile), { recursive: true });
		writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Keep the server usable even when the config directory is read-only.
	}
	return token;
}

function getInstallAuthTokenPath() {
	const base = process.env.PI_SPEAK_CONFIG_DIR
		|| process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "pi-speak")
		|| process.env.APPDATA && join(process.env.APPDATA, "pi-speak")
		|| join(process.cwd(), ".pi-speak");
	return join(base, "http-token");
}

function getStableServerId() {
	const explicit = process.env.PI_SPEAK_SERVER_ID?.trim();
	if (explicit) return explicit;
	return hostname() || "pi-speak";
}

function getReachableBaseUrls(port: number) {
	const urls: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries || []) {
			if (entry.family !== "IPv4" || entry.internal) continue;
			if (!isPrivateLanIpv4(entry.address) && !isTailscaleIpv4(entry.address)) continue;
			urls.push(`http://${entry.address}:${port}/`);
		}
	}
	return [...new Set(urls)];
}

function isPrivateLanIpv4(address: string) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailscaleIpv4(address: string) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function safeStatDirectory(path: string) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isPathInsideRoot(path: string, root: string) {
	const normalizedPath = resolve(path).toLowerCase();
	const normalizedRoot = resolve(root).toLowerCase();
	const separator = platform() === "win32" ? "\\" : "/";
	const rootWithSeparator = normalizedRoot.endsWith(separator) ? normalizedRoot : `${normalizedRoot}${separator}`;
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(rootWithSeparator);
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

function parsePositiveInt(value: string | null, defaultValue: number) {
	const parsed = Number.parseInt(value || "", 10);
	if (!Number.isFinite(parsed)) return defaultValue;
	if (parsed <= 0) return 1;
	if (parsed > 200) return 200;
	return parsed;
}

function parseNonNegativeInt(value: string | null, defaultValue = 0, max = Number.MAX_SAFE_INTEGER) {
	const parsed = Number.parseInt(value || "", 10);
	if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
	return Math.min(parsed, max);
}

function normalizeRemoteTurnSource(value: string | null): RemoteTurnSource | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "http-text") return "http-text";
	if (normalized === "http-voice") return "http-voice";
	if (normalized === "telegram-text") return "telegram-text";
	if (normalized === "telegram-voice") return "telegram-voice";
	return undefined;
}

function normalizeExecutionTraceOutcome(value: string | null): ExecutionTraceOutcome | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "no-input" ||
		normalized === "skipped" ||
		normalized === "dispatch-blocked" ||
		normalized === "dispatch-failed" ||
		normalized === "dispatch-success"
	) {
		return normalized;
	}
	return undefined;
}

function normalizeBackend(value: string | null): "pi" | "codex" | "shell" | "memory" | "wiki" | "defer" | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "pi" ||
		normalized === "codex" ||
		normalized === "shell" ||
		normalized === "memory" ||
		normalized === "wiki" ||
		normalized === "defer"
	) {
		return normalized;
	}
	return undefined;
}

function normalizeDispatchFilter(value: string | null): "all" | "dispatch" | "nondispatch" {
	const normalized = (value || "all").trim().toLowerCase();
	if (normalized === "dispatch") return "dispatch";
	if (normalized === "nondispatch") return "nondispatch";
	return "all";
}
