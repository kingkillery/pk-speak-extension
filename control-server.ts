import { spawnSync } from "node:child_process";
import { closeSync, createReadStream, existsSync, mkdirSync, opendirSync, openSync, readFileSync, realpathSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import dgram, { type Socket as UdpSocket } from "node:dgram";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, parse, resolve } from "node:path";
import { hostname, platform, tmpdir } from "node:os";
import QRCode from "qrcode";
import { clearRootVoiceDisable, enableRootVoiceDisable, getOrCreateInstallAuthToken, getReachableBaseUrls, isRootVoiceDisabled, isTailscaleIpv4, pickPhoneFacingBaseUrl } from "./pairing.js";
import Bonjour from "bonjour-service";
import { WebSocketServer, WebSocket } from "ws";
import "./realtime-types.js";
import { abortAllActiveTTS } from "./tts.js";
import { BusyError, type RemoteTurnSource, RemoteTurnResult } from "./remote-turn-manager.js";
import type { ExecutionTraceOutcome } from "./conversation-execution-trace.js";
import { readExecutionPlans, readExecutionTraces } from "./conversation-execution-trace.js";
import type { SessionDashboard, CompactRouteSlot } from "./session-routing.js";
import type { AgentDiscoverySnapshot } from "./agent-discovery.js";
import { getPiSpeakConfigDir } from "./setup-config.js";
import { buildHerdrSnapshot, readHerdrPane, sendHerdrAgent, sendHerdrPane, type HerdrAgentSendPayload, type HerdrPaneReadResult, type HerdrPaneSendPayload, type HerdrSnapshot } from "./herdr-client.js";
import { createDiskFallbackBinding } from "./herdr-agent-hub-disk.js";
import { AgentHubGateway, type AgentHubBinding } from "./herdr-agent-hub-gateway.js";
import { parseHubAgentId, parseHubChatRequest, parseHubKillConfirm } from "./herdr-agent-hub-schema.js";
import { buildOhMyPiAgentHubDashboardCached } from "./agent-hub-dashboard.js";
import { isWebSearchConfigured, runWebSearch } from "./web-search.js";
import { resolveLiveBackendKind } from "./live-backend.js";
import { canonicalRealtimeSessionPath } from "./realtime-session-target.js";
import { discoverTailnetGateways } from "./gateway-discovery.js";
import { verifyTailscalePeer, type TailscalePeerVerifier } from "./tailscale-peer-auth.js";

const DEFAULT_WINDOWS_WORKSPACE = "C:\\Dev";

export type ControlServerState = {

	enabled: boolean;
	host?: string;
	port?: number;
	authToken?: string;
	/** Identifies which role this server plays so health probes can tell the
	 * always-on gateway apart from a per-session in-agent control server. */
	role?: "gateway" | "session";
};

export type ControlActionResult = {
	ok: boolean;
	message: string;
	[key: string]: unknown;
};

function actionResultStatus(result: ControlActionResult): number {
	const status = result.status;
	return typeof status === "number" && Number.isInteger(status) && status >= 200 && status <= 599
		? status
		: result.ok ? 200 : 400;
}

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

export type SessionResumePayload = {
	sessionPath?: string;
	sessionId?: string;
	provider?: string;
	cwd?: string;
};

export type SessionLaunchPayload = {
	cwd?: string;
	prompt?: string;
	model?: string;
	provider?: string;
	sessionDir?: string;
	hubOnly?: boolean;
	targetNode?: string;
};

export type HubPublishPayload = {
	sessionPath: string;
	cwd?: string;
};

export type HubResumePayload = {
	link: string;
	cwd?: string;
};

export type SessionArchivePayload = {
	sessionPath?: string;
	action?: "archive" | "recover";
};

export type RemoteSlashCommand = {
	name: string;
	description?: string;
	usage?: string;
	examples?: string[];
	source?: "extension" | "prompt" | "skill" | "builtin";
};

export type GatewayAgentProvider = "pi" | "codex" | "claude" | "oh-my-pk";
export type ControlAgentProvider = GatewayAgentProvider | "gemini" | "gemini-live" | "elevenlabs" | "9router";

export type ControlServerStatus = {
	agent?: {
		provider: ControlAgentProvider;
		configuredProvider?: ControlAgentProvider;
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

export type WarpPsmuxPane = {
	session: string;
	window: string;
	pane: string;
	paneId: string;
	active: boolean;
	command?: string;
	title?: string;
};

export type WarpPsmuxWindow = {
	session: string;
	index: string;
	name: string;
	active: boolean;
	panes: WarpPsmuxPane[];
};

export type WarpPsmuxSession = {
	name: string;
	windows: WarpPsmuxWindow[];
	attached?: string;
};

export type WarpControlSnapshot = {
	available: boolean;
	sameTailnet: boolean;
	requestRemoteAddress: string;
	warpRemoteBaseUrl?: string;
	warpUriScheme: string;
	psmux: {
		available: boolean;
		executable: string;
		sessions: WarpPsmuxSession[];
		error?: string;
	};
};

export type WorkspaceEntry = {
	name: string;
	path: string;
	type: "directory" | "file";
	size?: number;
};

export type CollabLinkSnapshot = {
	active: boolean;
	webLink?: string;
	webViewLink?: string;
	link?: string;
	viewLink?: string;
	view?: boolean;
	startedAt?: string;
};

export type ControlServerOptions = {
	state: ControlServerState;
	/** Extra ports to try (base+1…base+N) when the requested port is already
	 * bound. Keeps parallel agent sessions from failing on EADDRINUSE. */
	portRetries?: number;
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
		action: "on" | "off" | "agent" | "stop" | "status" | "test" | "providers" | "provider" | "rewrite",
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
		agentProvider?: GatewayAgentProvider,
		model?: string,
		clientKey?: string,
	) => Promise<RemoteTurnResult>;
	onVoiceTurn: (
		buffer: Buffer,
		mimeType: string | undefined,
		includeAudio: boolean,
		target?: string,
		cwd?: string,
		mode?: "auto" | "live",
		agentProvider?: GatewayAgentProvider,
		model?: string,
		clientKey?: string,
	) => Promise<RemoteTurnResult>;
	onTurnCancel?: () => Promise<ControlActionResult> | ControlActionResult;
	getSessionDashboard?: () => SessionDashboard;
	/** Read-only cross-host manifest: session names + workspace git identity for secondary hosts. */
	getSessionManifest?: () => unknown;
	getCompactRouteSlots?: () => CompactRouteSlot[];
	onSessionRename?: (body: SessionRenamePayload) => Promise<ControlActionResult> | ControlActionResult;
	onSessionAlias?: (body: SessionAliasPayload) => Promise<ControlActionResult> | ControlActionResult;
	onSessionRemove?: (body: SessionRemovePayload) => Promise<ControlActionResult> | ControlActionResult;
	onSessionResume?: (body: SessionResumePayload) => Promise<ControlActionResult> | ControlActionResult;
	onSessionLaunch?: (body: SessionLaunchPayload) => Promise<ControlActionResult> | ControlActionResult;
	onSessionArchive?: (body: SessionArchivePayload) => Promise<ControlActionResult> | ControlActionResult;
	onHubPublish?: (body: HubPublishPayload) => Promise<ControlActionResult> | ControlActionResult;
	onHubResume?: (body: HubResumePayload) => Promise<ControlActionResult> | ControlActionResult;
	isHubHandoffReady?: () => boolean;
	/** Select (sessionPath) or deselect (null) the ompk resume session for a client. */
	onOmpSelectSession?: (clientKey: string, sessionPath: string | null) => { ok: boolean; error?: string } | void;
	onOmpGetSelectedSession?: (clientKey: string) => string | null;
	getDiscoveredAgents?: () => string[] | AgentDiscoverySnapshot;
	getHerdrSnapshot?: () => Promise<HerdrSnapshot>;
	readHerdrPane?: (paneId: string | undefined, lines: number | undefined) => Promise<HerdrPaneReadResult>;
	sendHerdrPane?: (payload: HerdrPaneSendPayload | undefined) => Promise<ControlActionResult>;
	sendHerdrAgent?: (payload: HerdrAgentSendPayload | undefined) => Promise<ControlActionResult>;
	tailSessionEvents?: (sinceOffset: number) => { events: unknown[]; nextOffset: number };
	agentHub?: AgentHubBinding;
	onRealtimeConnection?: (ws: WebSocket) => void;
	isTrustedTailnetPeer?: TailscalePeerVerifier;
	onBrainstorm?: (
		buffer: Buffer,
		mimeType: string | undefined,
		cwd?: string,
	) => Promise<{ ok: boolean; text: string; formatted: string; filePath: string }>;
};

type AudioArtifact = {
	id: string;
	path: string;
	mimeType: string;
	expiresAt: number;
};

/**
 * A staged one-shot TTS artifact for the speech-mode orb. Reuses the
 * AudioArtifact audio-serve pipeline, layered with the reply text the orb
 * renders alongside the player. Server-owned path under the audio temp dir;
 * never accepts a caller-supplied path.
 */
type SpeechArtifact = AudioArtifact & {
	text: string;
	createdAt: number;
	/** Server-owned parent directory (mkdtemp result); removed recursively. */
	cleanupDir: string;
};

type RateLimitBucket = {
	windowStartedAt: number;
	control: number;
	voice: number;
};

const MONO_ACTIONS = new Set(["on", "off", "status"]);
const PHONE_ACTIONS = new Set(["on", "off", "status", "code", "unpair"]);
const SPEAK_READ_ACTIONS = new Set(["status", "providers"]);
const SPEAK_WRITE_ACTIONS = new Set(["on", "off", "agent", "stop", "test", "provider", "rewrite"]);

const DEFAULT_HOST = process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0";
const DEFAULT_PORT = Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10);
const AUDIO_TTL_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_AUDIO_TTL_MS || "600000", 10);
const CLEANUP_INTERVAL_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_AUDIO_CLEANUP_MS || "30000", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_TIMEOUT_MS || "180000", 10);
const TEXT_BODY_LIMIT_BYTES = Number.parseInt(process.env.PI_SPEAK_HTTP_TEXT_BODY_LIMIT_BYTES || "65536", 10);
const VOICE_BODY_LIMIT_BYTES = Number.parseInt(process.env.PI_SPEAK_HTTP_VOICE_BODY_LIMIT_BYTES || "26214400", 10);
const SPEECH_ARTIFACT_BODY_LIMIT_BYTES = Number.parseInt(process.env.PI_SPEAK_HTTP_SPEECH_BODY_LIMIT_BYTES || "10485760", 10);
const SPEECH_ARTIFACT_TTL_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_SPEECH_TTL_MS || "600000", 10);
const SPEECH_TEXT_LIMIT_BYTES = Number.parseInt(process.env.PI_SPEAK_HTTP_SPEECH_TEXT_LIMIT_BYTES || "8192", 10);
const SPEECH_ALLOWED_MIME_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm"];
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.PI_SPEAK_HTTP_RATE_LIMIT_WINDOW_MS || "60000", 10);
const RATE_LIMIT_CONTROL = Number.parseInt(process.env.PI_SPEAK_HTTP_RATE_LIMIT_CONTROL || "20", 10);
const RATE_LIMIT_VOICE = Number.parseInt(process.env.PI_SPEAK_HTTP_RATE_LIMIT_VOICE || "6", 10);
const ALLOW_QUERY_TOKEN_FOR_AUDIO = isTruthy(process.env.PI_SPEAK_HTTP_ALLOW_QUERY_TOKEN_FOR_AUDIO || "false");
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
	private readonly getSessionManifest?: ControlServerOptions["getSessionManifest"];
	private readonly getCompactRouteSlots?: ControlServerOptions["getCompactRouteSlots"];
	private readonly onSessionRename?: ControlServerOptions["onSessionRename"];
	private readonly onSessionAlias?: ControlServerOptions["onSessionAlias"];
	private readonly onSessionRemove?: ControlServerOptions["onSessionRemove"];
	private readonly onSessionResume?: ControlServerOptions["onSessionResume"];
	private readonly onSessionLaunch?: ControlServerOptions["onSessionLaunch"];
	private readonly onSessionArchive?: ControlServerOptions["onSessionArchive"];
	private readonly onHubPublish?: ControlServerOptions["onHubPublish"];
	private readonly onHubResume?: ControlServerOptions["onHubResume"];
	private readonly isHubHandoffReady: NonNullable<ControlServerOptions["isHubHandoffReady"]>;
	private readonly onOmpSelectSession?: ControlServerOptions["onOmpSelectSession"];
	private readonly onOmpGetSelectedSession?: ControlServerOptions["onOmpGetSelectedSession"];
	private readonly getDiscoveredAgents?: ControlServerOptions["getDiscoveredAgents"];
	private readonly tailSessionEvents?: ControlServerOptions["tailSessionEvents"];
	private readonly getHerdrSnapshot: NonNullable<ControlServerOptions["getHerdrSnapshot"]>;
	private readonly readHerdrPane: NonNullable<ControlServerOptions["readHerdrPane"]>;
	private readonly sendHerdrPane: NonNullable<ControlServerOptions["sendHerdrPane"]>;
	private readonly sendHerdrAgent: NonNullable<ControlServerOptions["sendHerdrAgent"]>;
	private readonly onRealtimeConnection?: ControlServerOptions["onRealtimeConnection"];
	private readonly isTrustedTailnetPeer: TailscalePeerVerifier;
	private readonly onBrainstorm?: ControlServerOptions["onBrainstorm"];
	private wss?: WebSocketServer;
	private readonly realtimeClients = new Set<WebSocket>();
	private readonly state: ControlServerState;
	private readonly audioArtifacts = new Map<string, AudioArtifact>();
	private readonly speechArtifacts = new Map<string, SpeechArtifact>();
	private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();
	private readonly portRetries: number;
	private readonly _agentHubGateway: AgentHubGateway;
	private readonly agentHubCanMutate: boolean;
	private lastRemoteClient?: { at: number; agent?: string; address?: string };
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
			role: options.state.role ?? "gateway",
		};
		this.portRetries = Math.max(0, options.portRetries ?? 0);
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
		this.getSessionManifest = options.getSessionManifest;
		this.getCompactRouteSlots = options.getCompactRouteSlots;
		this.onSessionRename = options.onSessionRename;
		this.onSessionAlias = options.onSessionAlias;
		this.onSessionRemove = options.onSessionRemove;
		this.onSessionResume = options.onSessionResume;
		this.onSessionLaunch = options.onSessionLaunch;
		this.onSessionArchive = options.onSessionArchive;
		this.onHubPublish = options.onHubPublish;
		this.onHubResume = options.onHubResume;
		this.isHubHandoffReady = options.isHubHandoffReady || (() => false);
		this.onOmpSelectSession = options.onOmpSelectSession;
		this.onOmpGetSelectedSession = options.onOmpGetSelectedSession;
		this.getDiscoveredAgents = options.getDiscoveredAgents;
		this.getHerdrSnapshot = options.getHerdrSnapshot || (() => buildHerdrSnapshot());
		this.readHerdrPane = options.readHerdrPane || ((paneId, lines) => readHerdrPane(paneId, lines));
		this.sendHerdrPane = options.sendHerdrPane || ((payload) => sendHerdrPane(payload));
		this.sendHerdrAgent = options.sendHerdrAgent || ((payload) => sendHerdrAgent(payload));
		this.tailSessionEvents = options.tailSessionEvents;
		this.onRealtimeConnection = options.onRealtimeConnection;
		this.isTrustedTailnetPeer = options.isTrustedTailnetPeer ?? verifyTailscalePeer;
		this._agentHubGateway = new AgentHubGateway(options.agentHub ?? createDiskFallbackBinding(() => buildOhMyPiAgentHubDashboardCached()));
		this.agentHubCanMutate = options.agentHub?.canMutate === true;
		this.onBrainstorm = options.onBrainstorm;
	}

	// Read-only view for the conversational realtime gateway: a genuinely
	// narrow runtime object exposing only snapshot/detail/transcript, not chat/kill/
	// revive/stream. The Pick<> return type alone only narrows at compile
	// time -- the realtime gateway holds this behind an `any`-typed `server`
	// reference, so returning `this._agentHubGateway` directly would still let
	// a future (or buggy) realtime tool reach the mutating methods at runtime.
	get agentHubGateway(): Pick<AgentHubGateway, "snapshot" | "detail" | "transcript"> {
		return {
			snapshot: () => this._agentHubGateway.snapshot(),
			detail: (id, tailLines) => this._agentHubGateway.detail(id, tailLines),
			transcript: (id, opts) => this._agentHubGateway.transcript(id, opts),
		};
	}

	/**
	 * Trusted in-process bridge for the realtime assistant. Read operations are
	 * exposed directly; callers must complete the realtime approval flow before
	 * invoking any mutation on this facade.
	 */
	get realtimeBridge() {
		return {
			capabilities: {
				sessionRead: !!this.getSessionDashboard,
				sessionMessage: true,
				sessionResume: !!this.onSessionResume,
				sessionLaunch: !!this.onSessionLaunch,
				sessionArchive: !!this.onSessionArchive,
				agentHubMutations: this.agentHubCanMutate,
			},
			getSessionDashboard: () => this.getSessionDashboard?.(),
			sendSessionTurn: async (
				text: string,
				target?: { name?: string; sessionId?: string; sessionPath?: string; cwd?: string },
			) => {
				let routeTarget = target?.name;
				if (target?.sessionId || target?.sessionPath) {
					const dashboard = this.getSessionDashboard?.();
					const expectedPath = canonicalRealtimeSessionPath(target.sessionPath);
					const entry = dashboard?.sessions.find((session) =>
						(!target.sessionId || session.sessionId === target.sessionId)
						&& (!expectedPath || !!session.sessionPath && canonicalRealtimeSessionPath(session.sessionPath) === expectedPath));
					if (!entry) {
						return {
							replyText: "The approved session target is no longer available.",
							warnings: ["Session identity changed before the approved message was dispatched."],
						};
					}
					routeTarget = entry.name;
				}
				return await this.onTextTurn(text, false, routeTarget, target?.cwd, "live");
			},
			resumeSession: (payload: SessionResumePayload) =>
				this.onSessionResume
					? Promise.resolve(this.onSessionResume(payload))
					: Promise.resolve({ ok: false, message: "Session resume is not available." }),
			launchSession: (payload: SessionLaunchPayload) =>
				this.onSessionLaunch
					? Promise.resolve(this.onSessionLaunch(payload))
					: Promise.resolve({ ok: false, message: "Session launch is not available." }),
			archiveSession: (payload: SessionArchivePayload) =>
				this.onSessionArchive
					? Promise.resolve(this.onSessionArchive(payload))
					: Promise.resolve({ ok: false, message: "Session archive is not available." }),
			agentHub: {
				snapshot: () => this._agentHubGateway.snapshot(),
				detail: (id: Parameters<AgentHubGateway["detail"]>[0], tailLines: number) => this._agentHubGateway.detail(id, tailLines),
				transcript: (id: Parameters<AgentHubGateway["transcript"]>[0], opts?: Parameters<AgentHubGateway["transcript"]>[1]) =>
					this._agentHubGateway.transcript(id, opts),
				chat: (id: Parameters<AgentHubGateway["chat"]>[0], text: string, idempotencyKey: string | null) =>
					this._agentHubGateway.chat(id, text, idempotencyKey),
				kill: (id: Parameters<AgentHubGateway["kill"]>[0], confirmToken?: string) =>
					this._agentHubGateway.kill(id, confirmToken),
				revive: (id: Parameters<AgentHubGateway["revive"]>[0]) => this._agentHubGateway.revive(id),
			},
		};
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

		this.wss = new WebSocketServer({ noServer: true });
		this.wss.on("connection", (ws) => {
			this.realtimeClients.add(ws);
			ws.once("close", () => this.realtimeClients.delete(ws));
			ws.on("message", async (data, isBinary) => {
				if (!isBinary) {
					try {
						const msg = JSON.parse(data.toString());
						if (msg.type === "interrupt") {
							console.log("[Barge-in] Intercepted interrupt signal from client. Aborting synthesis and agent turns.");
							if (this.onTurnCancel) {
								await this.onTurnCancel();
							}
							abortAllActiveTTS();
							if (ws.readyState === WebSocket.OPEN) {
								ws.send(JSON.stringify({ type: "interrupt" }));
							}
						}
					} catch (e) {
						// ignore
					}
				}
			});

			if (this.onRealtimeConnection) {
				this.onRealtimeConnection(ws);
			} else {
				ws.close(1011, "Realtime voice gateway is not active.");
			}
		});

		this.server.on("upgrade", (req, socket, head) => {
			void (async () => {
				const url = new URL(req.url || "", `http://${req.headers.host || "127.0.0.1"}`);
				if (url.pathname === "/v1/live") {
					if (!(await this.isAuthorized(req, url, true))) {
						socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
						socket.destroy();
						return;
					}
					this.wss!.handleUpgrade(req, socket, head, (ws) => {
						this.wss!.emit("connection", ws, req);
					});
				} else {
					socket.destroy();
				}
			})().catch(() => {
				if (!socket.destroyed) {
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
					socket.destroy();
				}
			});
		});

		const maxAttempts = 1 + this.portRetries;
		let lastListenError: unknown;
		let listened = false;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const candidatePort = port + attempt;
			try {
				await new Promise<void>((resolve, reject) => {
					const server = this.server!;
					server.once("error", reject);
					server.listen(candidatePort, host, () => {
						server.off("error", reject);
						resolve();
					});
				});
				listened = true;
				break;
			} catch (error) {
				lastListenError = error;
				if ((error as { code?: string })?.code !== "EADDRINUSE") throw error;
			}
		}
		if (!listened) throw lastListenError;
		const address = this.server.address();
		if (address && typeof address === "object") {
			this.state.port = address.port;
		}

		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredAudio();
			this.cleanupStaleRateLimitBuckets();
		}, CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref?.();
		this.onStateChange({ enabled: true, host, port: this.state.port, authToken });
		await this.startDiscoveryResponder().catch((error) => {
			this.discoveryDiagnostics.udpEnabled = false;
			this.discoveryDiagnostics.lastError = `UDP discovery startup failed: ${getErrorMessage(error)}`;
		});
		this.startMdnsAdvertisement();
		return this.getRuntimeState();
	}

	disconnectRealtimeClients(reason = "Realtime voice stopped by the CLI.") {
		if (this.realtimeClients.size === 0) return 0;
		let disconnected = 0;
		for (const client of this.realtimeClients) {
			if (client.readyState !== WebSocket.OPEN) continue;
			client.close(1000, reason);
			disconnected += 1;
		}
		return disconnected;
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
		if (this.wss) {
			this.wss.close();
			this.wss = undefined;
		}
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		// Best-effort recursive cleanup of any remaining staged speech artifacts
		// so a gateway shutdown (mid-flight) doesn't leave pi-speak-speech-* dirs.
		for (const id of [...this.speechArtifacts.keys()]) {
			const artifact = this.speechArtifacts.get(id);
			this.speechArtifacts.delete(id);
			if (artifact) void rm(artifact.cleanupDir, { recursive: true, force: true }).catch(() => {});
		}
		this.onStateChange({ enabled: false });
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		this.applyCors(req, res, url);
		if (url.pathname === "/v1/hub/publish" || url.pathname === "/v1/hub/resume") {
			res.setHeader("Cache-Control", "no-store");
		}

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
			if (!(await this.isAuthorized(req, url, ALLOW_QUERY_TOKEN_FOR_AUDIO))) {
				this.writeJson(res, 401, { ok: false, error: "Unauthorized" });
				return;
			}
			this.recordRemoteClient(req, url);
			const id = decodeURIComponent(url.pathname.slice("/v1/audio/".length));
			await this.handleAudioRequest(id, res);
			return;
		}

		const allowQueryToken = req.method === "GET" && url.pathname === "/v1/events";
		if (!(await this.isAuthorized(req, url, allowQueryToken))) {
			this.writeJson(res, 401, { ok: false, error: "Unauthorized" });
			return;
		}
		this.recordRemoteClient(req, url);

		const rateLimitError = this.checkRateLimit(req, url, localRequest);
		if (rateLimitError) {
			this.writeJson(res, 429, rateLimitError);
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/status") {
			this.writeJson(res, 200, { ok: true, status: this.getStatus() });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/live/config") {
			this.writeJson(res, 200, {
				ok: true,
				webSearch: isWebSearchConfigured(),
				camera: true,
				backend: resolveLiveBackendKind(),
				backends: ["gemini", "openai-realtime"],
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/search") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const query = typeof payload?.query === "string" ? payload.query : "";
			if (!query.trim()) {
				this.writeJson(res, 400, { ok: false, error: "Body must include a non-empty query string." });
				return;
			}
			if (!isWebSearchConfigured()) {
				this.writeJson(res, 503, {
					ok: false,
					error: "Web search is not configured. Set SERPER_API_KEY or PI_SPEAK_SERPER_API_KEY on the gateway.",
				});
				return;
			}
			const result = await runWebSearch(query);
			this.writeJson(res, result.ok ? 200 : 502, result);
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

		if (req.method === "GET" && url.pathname === "/v1/pairing/status") {
			this.writeJson(res, 200, {
				ok: true,
				lastRemoteClient: this.lastRemoteClient ?? null,
				gateway: {
					port: this.state.port ?? DEFAULT_PORT,
					authRequired: !!this.state.authToken,
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

		if (req.method === "GET" && url.pathname === "/v1/warp") {
			this.writeJson(res, 200, { ok: true, warp: buildWarpControlSnapshot(req) });
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/warp/tab") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const result = openWarpTab(payload);
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/warp/tab-config") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const result = openWarpTabConfig(payload);
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/warp/psmux/session") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const result = createPsmuxSession(payload);
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/warp/psmux/window") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const result = createPsmuxWindow(payload);
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/herdr") {
			this.writeJson(res, 200, { ok: true, herdr: await this.getHerdrSnapshot() });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/herdr/pane/read") {
			const linesParam = url.searchParams.get("lines");
			const lines = linesParam ? Number.parseInt(linesParam, 10) : undefined;
			const result = await this.readHerdrPane(url.searchParams.get("paneId") || undefined, lines);
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/herdr/pane/send") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const result = await this.sendHerdrPane(payload as HerdrPaneSendPayload | undefined);
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/herdr/agents") {
			const snapshot = await this._agentHubGateway.snapshot();
			this.writeJson(res, 200, { ok: true, generatedAtMs: Date.now(), ...snapshot });
			return;
		}

		{
			const agentMatch = /^\/v1\/herdr\/agent\/([^/]+)(?:\/(chat|revive|kill))?$/.exec(url.pathname);
			if (agentMatch) {
				const id = parseHubAgentId(decodeURIComponent(agentMatch[1] ?? ""));
				if (!id) {
					this.writeJson(res, 400, { ok: false, code: "bad_id", error: "Malformed agent id." });
					return;
				}
				const action = agentMatch[2];
				if (req.method === "GET" && !action) {
					const lines = parsePositiveInt(url.searchParams.get("lines"), 80);
					const agent = await this._agentHubGateway.detail(id, Math.min(lines, 500));
					if (!agent) { this.writeJson(res, 404, { ok: false, code: "not_found", error: `Unknown agent: ${id}` }); return; }
					this.writeJson(res, 200, { ok: true, agent });
					return;
				}
				if (req.method === "POST" && action === "chat") {
					const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
					const parsed = parseHubChatRequest(payload, getPrimaryHeaderValue(req.headers["x-pi-speak-idempotency-key"]));
					if (!parsed) { this.writeJson(res, 400, { ok: false, code: "bad_request", error: "Body must be { text } (non-empty, <=8192 chars)." }); return; }
					const result = await this._agentHubGateway.chat(id, parsed.text, parsed.idempotencyKey);
					this.writeJson(res, result.ok ? 200 : result.status, result);
					return;
				}
				if (req.method === "POST" && action === "revive") {
					const result = await this._agentHubGateway.revive(id);
					this.writeJson(res, result.ok ? 200 : result.status, result);
					return;
				}
				if (req.method === "POST" && action === "kill") {
					const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
					const confirm = parseHubKillConfirm(payload ?? undefined);
					const result = await this._agentHubGateway.kill(id, confirm?.confirmToken);
					this.writeJson(res, result.ok ? 200 : result.status, result);
					return;
				}
			}
		}

		{
			const streamMatch = /^\/v1\/herdr\/stream\/([^/]+)$/.exec(url.pathname);
			if (req.method === "GET" && streamMatch) {
				const id = parseHubAgentId(decodeURIComponent(streamMatch[1] ?? ""));
				if (!id) { this.writeJson(res, 400, { ok: false, code: "bad_id", error: "Malformed agent id." }); return; }
				const fromByte = parseNonNegativeInt(url.searchParams.get("fromByte"), 0);
				// SSE: long-lived stream — don't apply REQUEST_TIMEOUT_MS here.
				await this._agentHubGateway.stream(id, res, fromByte);
				return;
			}
		}
		if (req.method === "POST" && url.pathname === "/v1/herdr/agent/send") {
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const result = await this.sendHerdrAgent(payload as HerdrAgentSendPayload | undefined);
			this.writeJson(res, result.ok ? 200 : 400, result);
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

		if (req.method === "GET" && url.pathname === "/v1/workspace/file") {
			const result = readWorkspaceFile(url.searchParams.get("path") || undefined);
			if (!result.ok) {
				this.writeJson(res, result.status, { ok: false, error: result.error });
				return;
			}
			const { ok: _ok, ...file } = result;
			this.writeJson(res, 200, { ok: true, file });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/collab-link") {
			this.writeJson(res, 200, { ok: true, collab: readCollabLink() });
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

		if (req.method === "GET" && url.pathname === "/v1/sessions/manifest") {
			if (!this.getSessionManifest) {
				this.writeJson(res, 501, { ok: false, error: "Session manifest is not available on this gateway." });
				return;
			}
			this.writeJson(res, 200, { ok: true, manifest: this.getSessionManifest() });
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/gateways") {
			// Host-assisted tailnet discovery: phones cannot enumerate peers, so any
			// paired gateway doubles as the roster of every other live gateway.
			const roster = await discoverTailnetGateways({ ports: [...new Set([this.state.port ?? DEFAULT_PORT, 8767])] });
			this.writeJson(res, 200, { ok: true, ...roster });
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

		if (req.method === "POST" && url.pathname === "/v1/hub/publish") {
			res.setHeader("Cache-Control", "no-store");
			if (!this.onHubPublish) {
				this.writeJson(res, 501, { ok: false, error: "Hub publish is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const sessionPath = typeof payload?.sessionPath === "string" ? payload.sessionPath.trim() : "";
			const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() || undefined : undefined;
			if (!sessionPath || (payload?.cwd !== undefined && typeof payload.cwd !== "string")) {
				this.writeJson(res, 400, { ok: false, error: "Invalid payload: sessionPath is required and cwd must be a string." });
				return;
			}
			const result = await this.onHubPublish({ sessionPath, cwd });
			this.writeJson(res, actionResultStatus(result), result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/hub/resume") {
			res.setHeader("Cache-Control", "no-store");
			if (!this.onHubResume) {
				this.writeJson(res, 501, { ok: false, error: "Hub resume is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const link = typeof payload?.link === "string" ? payload.link.trim() : "";
			const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() || undefined : undefined;
			if (!link || (payload?.cwd !== undefined && typeof payload.cwd !== "string")) {
				this.writeJson(res, 400, { ok: false, error: "Invalid payload: link is required and cwd must be a string." });
				return;
			}
			const result = await this.onHubResume({ link, cwd });
			this.writeJson(res, actionResultStatus(result), result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/sessions/resume") {
			if (!this.onSessionResume) {
				this.writeJson(res, 501, { ok: false, error: "Session resume is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const sessionPath = typeof payload?.sessionPath === "string" ? payload.sessionPath : undefined;
			const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
			const provider = typeof payload?.provider === "string" ? payload.provider : undefined;
			const cwd = typeof payload?.cwd === "string" ? payload.cwd : undefined;
			if (!sessionPath && !sessionId) {
				this.writeJson(res, 400, { ok: false, error: "Invalid payload: sessionPath or sessionId is required." });
				return;
			}
			const result = await this.onSessionResume({ sessionPath, sessionId, provider, cwd });
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}
		if (req.method === "POST" && url.pathname === "/v1/sessions/launch") {
			if (!this.onSessionLaunch) {
				this.writeJson(res, 501, { ok: false, error: "Session launch is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			if (!payload) {
				this.writeJson(res, 400, { ok: false, error: "Invalid JSON body." });
				return;
			}
			const fieldTypes: Record<string, "string" | "boolean"> = {
				cwd: "string",
				prompt: "string",
				model: "string",
				provider: "string",
				sessionDir: "string",
				hubOnly: "boolean",
				targetNode: "string",
			};
			for (const [field, expected] of Object.entries(fieldTypes)) {
				if (payload[field] !== undefined && typeof payload[field] !== expected) {
					this.writeJson(res, 400, { ok: false, error: `Invalid payload: ${field} must be a ${expected}.` });
					return;
				}
			}
			const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
			const prompt = typeof payload.prompt === "string" ? payload.prompt : undefined;
			const model = typeof payload.model === "string" ? payload.model : undefined;
			const provider = typeof payload.provider === "string" ? payload.provider : undefined;
			const sessionDir = typeof payload.sessionDir === "string" ? payload.sessionDir : undefined;
			const hubOnly = typeof payload.hubOnly === "boolean" ? payload.hubOnly : undefined;
			const targetNode = typeof payload.targetNode === "string" ? payload.targetNode : undefined;
			const result = await this.onSessionLaunch({ cwd, prompt, model, provider, sessionDir, hubOnly, targetNode });
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/sessions/archive") {
			if (!this.onSessionArchive) {
				this.writeJson(res, 501, { ok: false, error: "Session archive is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			if (!payload) {
				this.writeJson(res, 400, { ok: false, error: "Invalid JSON body." });
				return;
			}
			const sessionPath = typeof payload.sessionPath === "string" ? payload.sessionPath : undefined;
			if (!sessionPath) {
				this.writeJson(res, 400, { ok: false, error: "sessionPath is required." });
				return;
			}
			const action = payload.action === "recover" ? "recover" : "archive";
			const result = await this.onSessionArchive({ sessionPath, action });
			this.writeJson(res, result.ok ? 200 : 400, result);
			return;
		}

		if (req.method === "GET" && url.pathname === "/v1/projects") {
			const base = url.searchParams.get("base")?.trim()
				|| process.env.PI_SPEAK_PROJECTS_BASE?.trim()
				|| (() => {
					const cwd = getDefaultWorkspacePath();
					const parent = dirname(resolve(cwd));
					return parent;
				})();
			const projects: string[] = [];
			try {
				const dir = opendirSync(resolve(base));
				try {
					let dirent = dir.readSync();
					while (dirent) {
						if (dirent.isDirectory() && !dirent.name.startsWith(".")) {
							projects.push(dirent.name);
						}
						dirent = dir.readSync();
					}
				} finally {
					dir.closeSync();
				}
			} catch {}
			projects.sort((a, b) => a.localeCompare(b));
			this.writeJson(res, 200, { ok: true, base: resolve(base), projects });
			return;
		}

		if (req.method === "POST" && (url.pathname === "/v1/ompk/select-session" || url.pathname === "/v1/omp/select-session")) {
			if (!this.onOmpSelectSession) {
				this.writeJson(res, 501, { ok: false, error: "Omp session selection is not available on this gateway." });
				return;
			}
			const payload = await this.readJsonObject(req, TEXT_BODY_LIMIT_BYTES);
			const rawPath = typeof payload?.sessionPath === "string" ? payload.sessionPath.trim() : "";
			const explicitClient = typeof payload?.clientId === "string" ? payload.clientId : undefined;
			const clientKey = this.clientKey(req, explicitClient);
			// Empty sessionPath (or clear:true) deselects this client's ompk session,
			// returning it to normal backend routing.
			const clear = payload?.clear === true || rawPath.length === 0;
			const sessionPath = clear ? null : rawPath;
			const result = this.onOmpSelectSession?.(clientKey, sessionPath);
			if (result && result.ok === false) {
				this.writeJson(res, 400, { ok: false, error: result.error || "Invalid ompk session." });
				return;
			}
			this.writeJson(res, 200, { ok: true, sessionPath, cleared: clear });
			return;
		}

		if (req.method === "GET" && (url.pathname === "/v1/ompk/selected-session" || url.pathname === "/v1/omp/selected-session")) {
			if (!this.onOmpGetSelectedSession) {
				this.writeJson(res, 501, { ok: false, error: "Omp session selection is not available on this gateway." });
				return;
			}
			const clientKey = this.clientKey(req, url.searchParams.get("clientId") || undefined);
			const sessionPath = this.onOmpGetSelectedSession(clientKey) ?? null;
			this.writeJson(res, 200, { ok: true, sessionPath });
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
			if (!(await this.isAuthorized(req, url, true))) {
				this.writeJson(res, 401, { ok: false, error: "Unauthorized" });
				return;
			}
			await this.handleEventStream(req, url, res);
			return;
		}

		if (await this.handleMonoRoute(req, res, url)) return;
		if (await this.handlePhoneRoute(req, res, url)) return;
		if (await this.handleSpeakRoute(req, res, url)) return;
		if (await this.handleSpeechRoute(req, res, url)) return;

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
			const model = parseModelOverride(url.searchParams.get("model"));
			const result = await this.withTimeout(this.onTextTurn(text, includeAudio, target, cwd, mode, agentProvider, model, this.clientKey(req, url.searchParams.get("clientId") || undefined)));
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
			const model = parseModelOverride(typeof payload?.model === "string" ? payload.model : undefined);
			const result = await this.withTimeout(this.onTextTurn(text, includeAudio, target, cwd, mode, agentProvider, model, this.clientKey(req, typeof payload?.clientId === "string" ? payload.clientId : undefined)));
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
			const model = parseModelOverride(url.searchParams.get("model"));
			const result = await this.withTimeout(this.onVoiceTurn(buffer, mimeType, includeAudio, target, cwd, mode, agentProvider, model, this.clientKey(req, url.searchParams.get("clientId") || undefined)));
			this.writeJson(res, 200, await this.createTurnPayload(result));
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/brainstorm") {
			if (!this.onBrainstorm) {
				this.writeJson(res, 501, { ok: false, error: "Brainstorming mode is not available on this gateway." });
				return;
			}
			const mimeType = getPrimaryHeaderValue(req.headers["content-type"]);
			if (!isSupportedVoiceContentType(mimeType)) {
				this.writeJson(res, 415, { ok: false, error: `Unsupported voice content type: ${mimeType || "unknown"}` });
				return;
			}
			const buffer = await this.readBinaryBody(req, VOICE_BODY_LIMIT_BYTES);
			const cwd = getLaunchCwdFromUrl(url);
			const result = await this.withTimeout(this.onBrainstorm(buffer, mimeType, cwd));
			this.writeJson(res, 200, result);
			return;
		}

		this.writeJson(res, 404, { ok: false, error: "Not found" });
	}

	private async handlePublicRoute(req: IncomingMessage, url: URL, res: ServerResponse) {
		if (url.pathname === "/health") {
			const tailnetTrusted = await this.isTrustedTailnetRequest(req);
			this.writeJson(res, 200, {
				ok: true,
				app: "pi-speak",
				role: this.state.role ?? "gateway",
				authRequired: !!this.state.authToken && !tailnetTrusted,
				tailnetPeerVerified: tailnetTrusted,
			});
			return true;
		}

		if (url.pathname === "/.well-known/pi-speak" || url.pathname === "/v1/discovery") {
			const tailnetTrusted = await this.isTrustedTailnetRequest(req);
			this.writeJson(res, 200, this.buildDiscoveryDescriptor(req, url, tailnetTrusted));
			return true;
		}

		if (url.pathname === "/" || url.pathname === "/app") {
			this.redirect(res, "/app/");
			return true;
		}

		if (url.pathname === "/connect" || url.pathname === "/connect/") {
			// The connect page renders the pairing QR (which embeds the auth token),
			// so it is strictly loopback-only: the desktop window on this machine.
			const remote = normalizeRemoteAddress(req.socket.remoteAddress || "");
			if (!isLoopback(remote) || !isLoopbackHost(url.hostname)) {
				this.writeJson(res, 403, { ok: false, error: "The connect page is only available on this machine (open http://127.0.0.1 locally)." });
				return true;
			}
			await this.handleConnectPage(req, url, res);
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

		if (url.pathname === "/orb/" || url.pathname === "/orb/index.html" || url.pathname === "/orb") {
			if (url.pathname === "/orb") {
				res.statusCode = 302;
				res.setHeader("Location", "/orb/");
				res.end();
				return true;
			}
			await this.serveStaticFile(join(REMOTE_APP_DIR, "orb.html"), "text/html; charset=utf-8", res, "no-store");
			return true;
		}

		if (url.pathname === "/orb/orb.js") {
			await this.serveStaticFile(join(REMOTE_APP_DIR, "orb.js"), "application/javascript; charset=utf-8", res, "no-store");
			return true;
		}

		if (url.pathname === "/orb/orb-approvals.js") {
			await this.serveStaticFile(join(REMOTE_APP_DIR, "orb-approvals.js"), "application/javascript; charset=utf-8", res, "no-store");
			return true;
		}

		if (url.pathname === "/orb/orb.css") {
			await this.serveStaticFile(join(REMOTE_APP_DIR, "orb.css"), "text/css; charset=utf-8", res, "no-store");
			return true;
		}

		if (url.pathname === "/hub/" || url.pathname === "/hub/index.html" || url.pathname === "/hub") {
			if (url.pathname === "/hub") {
				res.statusCode = 302;
				res.setHeader("Location", "/hub/");
				res.end();
				return true;
			}
			await this.serveStaticFile(join(REMOTE_APP_DIR, "hub.html"), "text/html; charset=utf-8", res, "no-store");
			return true;
		}

		if (url.pathname === "/hub/hub.js") {
			await this.serveStaticFile(join(REMOTE_APP_DIR, "hub.js"), "application/javascript; charset=utf-8", res, "no-store");
			return true;
		}

		if (url.pathname === "/hub/hub.css") {
			await this.serveStaticFile(join(REMOTE_APP_DIR, "hub.css"), "text/css; charset=utf-8", res, "no-store");
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

		if (url.pathname === "/app/barge-in-detector.js") {
			await this.serveStaticFile(
				join(REMOTE_APP_DIR, "barge-in-detector.js"),
				"application/javascript; charset=utf-8",
				res,
				"no-store",
			);
			return true;
		}

		if (url.pathname === "/app/replay-capture.js" || url.pathname === "/orb/replay-capture.js") {
			await this.serveStaticFile(
				join(REMOTE_APP_DIR, "replay-capture.js"),
				"application/javascript; charset=utf-8",
				res,
				"no-store",
			);
			return true;
		}

		if (url.pathname === "/app/live-capture-worklet.js") {
			await this.serveStaticFile(
				join(REMOTE_APP_DIR, "live-capture-worklet.js"),
				"application/javascript; charset=utf-8",
				res,
				"no-store",
			);
			return true;
		}

		if (url.pathname === "/app/live-playback-worklet.js") {
			await this.serveStaticFile(
				join(REMOTE_APP_DIR, "live-playback-worklet.js"),
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

	private buildDiscoveryDescriptor(req: IncomingMessage, url: URL, tailnetTrusted = false) {
		const status = this.getStatus();
		const baseUrl = getRequestBaseUrl(req, url);
		const authRequired = !!this.state.authToken && !tailnetTrusted;
		return {
			schema: "pi-speak.discovery.v1",
			app: "pi-speak",
			package: "pi-speak-pk",
			version: process.env.npm_package_version || "0.0.0",
			serverId: getStableServerId(),
			name: `Pi Speak on ${hostname() || "machine"}`,
			authRequired,
			pairingRequired: authRequired,
			pairingMethods: ["setup-qr"],
			pairing: {
				required: authRequired,
				methods: ["setup-qr", "native-deep-link"],
				setupPath: "/setup",
				deepLinkScheme: "pi-speak://setup",
				tokenDelivery: "setup-qr-only",
				instructions: "Run /pk-remote on the computer and scan the setup QR. Discovery never exposes the token.",
			},
			security: {
				publicDiscoveryIncludesToken: false,
				tokenDelivery: "setup-qr-only",
				tailnetPeerVerified: tailnetTrusted,
				tailnetVerification: "tailscaled-whois-or-serve-identity",
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
				brainstorm: "/v1/brainstorm",
				route: "/v1/route",
				workspace: "/v1/workspace",
				workspaceFile: "/v1/workspace/file",
				collabLink: "/v1/collab-link",
				sessions: "/v1/sessions",
				sessionLaunch: "/v1/sessions/launch",
				hubPublish: "/v1/hub/publish",
				hubResume: "/v1/hub/resume",
				slots: "/v1/sessions/slots",
				sessionManifest: "/v1/sessions/manifest",
				gateways: "/v1/gateways",
				agents: "/v1/agents",
				events: "/v1/events",
				warp: "/v1/warp",
				warpTab: "/v1/warp/tab",
				warpTabConfig: "/v1/warp/tab-config",
				warpPsmuxSession: "/v1/warp/psmux/session",
				herdr: "/v1/herdr",
				herdrPaneRead: "/v1/herdr/pane/read",
				herdrPaneSend: "/v1/herdr/pane/send",
				herdrAgentSend: "/v1/herdr/agent/send",
				herdrAgents: "/v1/herdr/agents",
				herdrAgent: "/v1/herdr/agent/:id",
				herdrStream: "/v1/herdr/stream/:id",
				warpPsmuxWindow: "/v1/warp/psmux/window",
			},
			capabilities: [
				"text-turn",
				"voice-turn",
				"audio-reply",
				"routing",
				"slash-commands",
				"workspace-browse",
				"workspace-file-read",
				"collab-link",
				"session-launch",
				...(this.onHubPublish && this.onHubResume && this.isHubHandoffReady() ? ["hub-handoff"] : []),
				"colab-launch",
				"turn-cancel",
				"progress-events",
				"pwa",
				"android-apk",
				"session-dashboard",
				"route-slots",
				"session-mutations",
				"agent-discovery",
				"psmux-control",
				"herdr-control",
				"agent-hub",
			],
			agent: status.agent
				? {
					provider: status.agent.provider,
					configuredProvider: status.agent.configuredProvider,
					model: status.agent.model,
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
		if (status.agent?.model) {
			setupParams.set("agent_model", status.agent.model);
		}
		const agentProvider = status.agent?.provider;
		if (agentProvider === "pi"
			|| agentProvider === "codex"
			|| agentProvider === "claude"
			|| agentProvider === "oh-my-pk"
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

	/**
	 * Desktop pairing page (loopback-only). Shows the pi-speak://setup QR with the
	 * phone-facing base URL + persistent token, and live "phone connected" status
	 * polled from /v1/pairing/status. This is the window `pi-speak-server` opens.
	 */
	private async handleConnectPage(req: IncomingMessage, url: URL, res: ServerResponse) {
		const port = this.state.port ?? DEFAULT_PORT;
		const token = this.state.authToken || "";
		const status = this.getStatus();
		const phoneBaseUrl = pickPhoneFacingBaseUrl(port);
		const profileName = url.searchParams.get("profile_name")
			|| process.env.PI_SPEAK_PROFILE_NAME?.trim()
			|| (hostname() || "Pi Speak");
		const setupParams = new URLSearchParams({
			base_url: phoneBaseUrl,
			machine_id: getStableServerId(),
			profile_name: profileName,
			connection_mode: isTailscaleHostname(new URL(phoneBaseUrl).hostname) ? "tailscale" : "manual",
			workspace_root: getWorkspaceRoot(),
			workspace_path: getDefaultWorkspacePath(),
		});
		if (token) setupParams.set("token", token);
		const defaultTarget = status.remote.defaultTarget || status.remote.currentSession || "";
		if (defaultTarget) setupParams.set("default_target", defaultTarget);
		const appSetupUrl = `pi-speak://setup?${setupParams.toString()}`;
		const setupPageUrl = new URL(`/setup${token ? `?token=${encodeURIComponent(token)}` : ""}`, phoneBaseUrl).toString();
		const apkUrl = new URL("/download/pi-speak.apk", phoneBaseUrl).toString();
		const qrSvg = await QRCode.toString(appSetupUrl, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 300 });
		res.statusCode = 200;
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		res.end(renderConnectHtml({
			profileName,
			phoneBaseUrl,
			appSetupUrl,
			setupPageUrl,
			apkUrl,
			apkAvailable: existsSync(ANDROID_APK_PATH),
			reachableUrls: getReachableBaseUrls(port),
			qrSvg,
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
			this.writeJson(res, 200, await this.onSpeakAction(action as "on" | "off" | "agent" | "stop" | "test"));
			return true;
		}
		return false;
	}

	/**
	 * One-shot TTS playback staging + speech-disable controls for the orb
	 * speech mode. Separate from /v1/speak (which drives the extension's
	 * speakState). Body is raw audio bytes only — never accepts a path —
	 * to avoid turning the gateway into an arbitrary local-file reader.
	 */
	private async handleSpeechRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
		if (!url.pathname.startsWith("/v1/speech/")) return false;

		// GET /v1/speech/staged/:id — orb fetches metadata + audio URL.
		if (req.method === "GET" && url.pathname.startsWith("/v1/speech/staged/")) {
			const id = decodeURIComponent(url.pathname.slice("/v1/speech/staged/".length)).trim();
			if (!id) { this.writeJson(res, 400, { ok: false, error: "Missing speech id." }); return true; }
			const artifact = this.speechArtifacts.get(id);
			if (!artifact || artifact.expiresAt <= Date.now()) {
				if (artifact) this.deleteSpeechArtifact(id, artifact);
				this.writeJson(res, 404, { ok: false, error: "Speech artifact not found or expired." });
				return true;
			}
			this.writeJson(res, 200, {
				ok: true,
				id: artifact.id,
				text: artifact.text,
				audioUrl: `/v1/speech/audio/${artifact.id}`,
				mimeType: artifact.mimeType,
				expiresAt: artifact.expiresAt,
				speechDisabled: isRootVoiceDisabled(),
			});
			return true;
		}

		// GET /v1/speech/audio/:id — orb audio element fetches bytes.
		// Reuses the same TTL/expiry/cleanup path as /v1/audio.
		if (req.method === "GET" && url.pathname.startsWith("/v1/speech/audio/")) {
			const id = decodeURIComponent(url.pathname.slice("/v1/speech/audio/".length)).trim();
			if (!id) { this.writeJson(res, 400, { ok: false, error: "Missing speech id." }); return true; }
			const artifact = this.speechArtifacts.get(id);
			if (!artifact || artifact.expiresAt <= Date.now() || !existsSync(artifact.path)) {
				if (artifact) this.deleteSpeechArtifact(id, artifact);
				this.writeJson(res, 404, { ok: false, error: "Speech artifact not found or expired." });
				return true;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", artifact.mimeType);
			res.setHeader("Cache-Control", "no-store");
			createReadStream(artifact.path).pipe(res);
			return true;
		}

		if (req.method === "POST" && url.pathname === "/v1/speech/stage") {
			const mimeType = (getPrimaryHeaderValue(req.headers["content-type"]) || "").toLowerCase();
			if (!SPEECH_ALLOWED_MIME_TYPES.includes(mimeType)) {
				this.writeJson(res, 415, { ok: false, error: `Unsupported audio MIME type: ${mimeType || "unknown"}. Allowed: ${SPEECH_ALLOWED_MIME_TYPES.join(", ")}.` });
				return true;
			}
			// Reply text travels out-of-band in a base64url-encoded UTF-8 header
			// (X-Pi-Speak-Speech-Text-B64): Node's HTTP parser rejects most
			// non-ASCII and control chars in raw header values, so passing the
			// text directly would silently corrupt/lose text on emoji/CJK/etc.
			// Byte-limit BEFORE utf8 decode so multi-byte chars can't push past cap.
			const encodedText = (getPrimaryHeaderValue(req.headers["x-pi-speak-speech-text-b64"]) || "").trim();
			let text = "";
			if (encodedText) {
				const decoded = Buffer.from(encodedText, "base64url");
				if (decoded.byteLength > SPEECH_TEXT_LIMIT_BYTES) {
					this.writeJson(res, 400, { ok: false, error: `Speech text exceeds ${SPEECH_TEXT_LIMIT_BYTES}-byte limit.` });
					return true;
				}
				text = decoded.toString("utf8");
			}
			const buffer = await this.readBinaryBody(req, SPEECH_ARTIFACT_BODY_LIMIT_BYTES);
			if (buffer.byteLength === 0) {
				this.writeJson(res, 400, { ok: false, error: "Empty audio body." });
				return true;
			}
			let stagedPath: string;
			let cleanupDir: string;
			try {
				cleanupDir = await mkdtemp(join(tmpdir(), "pi-speak-speech-"));
				const ext = mimeTypeToExtension(mimeType);
				stagedPath = join(cleanupDir, `speech.${ext}`);
				await writeFile(stagedPath, buffer);
			} catch (error) {
				this.writeJson(res, 500, { ok: false, error: `Failed to stage audio: ${getErrorMessage(error)}` });
				return true;
			}
			const id = randomUUID();
			const artifact: SpeechArtifact = {
				id,
				path: stagedPath,
				mimeType,
				expiresAt: Date.now() + SPEECH_ARTIFACT_TTL_MS,
				text,
				createdAt: Date.now(),
				cleanupDir,
			};
			this.speechArtifacts.set(id, artifact);
			this.writeJson(res, 200, {
				ok: true,
				id,
				audioUrl: `/v1/speech/audio/${id}`,
				stagedUrl: `/v1/speech/staged/${id}`,
				expiresAt: artifact.expiresAt,
			});
			return true;
		}

		// POST /v1/speech/disable — flips the hard-stop sentinel so future
		// terminal-initiated TTS no-ops. Idempotent.
		if (req.method === "POST" && url.pathname === "/v1/speech/disable") {
			enableRootVoiceDisable();
			this.writeJson(res, 200, { ok: true, disabled: true, message: "Speech disabled from orb." });
			return true;
		}

		// POST /v1/speech/enable — clears the hard-stop sentinel.
		if (req.method === "POST" && url.pathname === "/v1/speech/enable") {
			clearRootVoiceDisable();
			this.writeJson(res, 200, { ok: true, disabled: false, message: "Speech re-enabled from orb." });
			return true;
		}

		// GET /v1/speech/disabled — orb polls to render current state.
		if (req.method === "GET" && url.pathname === "/v1/speech/disabled") {
			this.writeJson(res, 200, { ok: true, disabled: isRootVoiceDisabled() });
			return true;
		}

		// Unknown /v1/speech/* path: 404 rather than fall through.
		this.writeJson(res, 404, { ok: false, error: "Unknown speech route." });
		return true;
	}

	/**
	 * Centralized recursive cleanup of a staged speech artifact. Removes the
	 * parent mkdtemp dir so we don't leak pi-speak-speech-* directories on
	 * expiry, 404, or stop().
	 */
	private deleteSpeechArtifact(id: string, artifact: SpeechArtifact) {
		this.speechArtifacts.delete(id);
		void rm(artifact.cleanupDir, { recursive: true, force: true }).catch(() => {});
	}

	private recordRemoteClient(req: IncomingMessage, url: URL) {
		// Pairing-status polls are how UIs *observe* connection state; they must
		// never count as the phone activity they are trying to detect.
		if (url.pathname === "/v1/pairing/status") return;
		const remote = normalizeRemoteAddress(req.socket.remoteAddress || "");
		if (!remote || isLoopback(remote)) return;
		this.lastRemoteClient = {
			at: Date.now(),
			agent: getPrimaryHeaderValue(req.headers["user-agent"]) || undefined,
			address: remote,
		};
	}

	private async isAuthorized(req: IncomingMessage, url: URL, allowQueryToken: boolean) {
		const token = this.state.authToken || "";
		if (!token) return true;
		if (isLocalRequest(req, url)) return true;
		// Accept any token from PI_SPEAK_EXTRA_TOKEN (comma-separated) in addition to the primary.
		const extraTokens = (process.env.PI_SPEAK_EXTRA_TOKEN || "")
			.split(",").map(t => t.trim()).filter(Boolean);
		const isValid = (presented: string) =>
			presented === token || extraTokens.includes(presented);
		const headerToken = getPrimaryHeaderValue(req.headers["x-pi-speak-token"]) || "";
		if (headerToken && isValid(headerToken)) return true;
		const authHeader = getPrimaryHeaderValue(req.headers.authorization) || "";
		const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
		if (bearerToken && isValid(bearerToken)) return true;
		if (allowQueryToken) {
			const queryToken = url.searchParams.get("token") || "";
			if (queryToken && isValid(queryToken)) return true;
		}
		return this.isTrustedTailnetRequest(req);
	}

	private async isTrustedTailnetRequest(req: IncomingMessage) {
		const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
		if (!remoteAddress) return false;
		const serveLogin = (getPrimaryHeaderValue(req.headers["tailscale-user-login"]) || "").trim();
		const requestHost = getPrimaryHeaderValue(req.headers.host) || "";
		if (
			serveLogin
			&& serveLogin.length <= 512
			&& isLoopback(remoteAddress)
			&& isLoopbackHost(this.state.host || "")
			&& isTailscaleDnsHost(requestHost)
		) {
			return true;
		}
		try {
			return await this.isTrustedTailnetPeer(remoteAddress, req.socket.remotePort);
		} catch {
			return false;
		}
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

	// Stable per-client key for scoping per-client state (e.g. ompk session
	// selection). An explicit `clientId` (header or body) wins; otherwise derive
	// from remote address + presented token so distinct devices/tokens are
	// distinct clients. Mirrors the rate-limit bucket key.
	private clientKey(req: IncomingMessage, explicit?: string): string {
		const fromHeader = getPrimaryHeaderValue(req.headers["x-pi-speak-client"]);
		const id = (explicit || fromHeader || "").trim();
		if (id) return `id:${id}`;
		const remote = req.socket.remoteAddress || "unknown";
		const token = this.extractPresentedToken(req) || "anon";
		return `${remote}:${token}`;
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
		// Enforce the TTL at read time, not only via the periodic sweep: between
		// sweeps (or if cleanup is delayed/disabled) an expired artifact must
		// not remain accessible. Treat expired as 404 and drop opportunistically.
		if (artifact.expiresAt <= Date.now()) {
			this.audioArtifacts.delete(id);
			void rm(artifact.path, { force: true }).catch(() => {});
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
		// Speech artifacts share the same sweep (separate TTL/size cap, but
		// same disk-backed lifecycle so we don't leak staged TTS files).
		for (const [id, artifact] of this.speechArtifacts.entries()) {
			if (artifact.expiresAt <= now) this.deleteSpeechArtifact(id, artifact);
		}
	}

	// Evict rate-limit buckets whose window has fully elapsed: an expired bucket is
	// indistinguishable from a fresh one (checkRateLimit resets counters on a stale
	// window), so dropping it is behavior-preserving and bounds the Map. Without this
	// the Map grows once per distinct remoteAddress:token forever — a slow memory leak
	// on a long-lived public/Tailscale gateway facing rotating IPs and probe tokens.
	private cleanupStaleRateLimitBuckets() {
		const now = Date.now();
		for (const [key, bucket] of this.rateLimitBuckets.entries()) {
			if (now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
				this.rateLimitBuckets.delete(key);
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


function buildWarpControlSnapshot(req: IncomingMessage): WarpControlSnapshot {
	const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
	const warpRemoteBaseUrl = process.env.PI_SPEAK_WARP_REMOTE_BASE_URL?.trim() || undefined;
	const psmux = listPsmuxSessions();
	return {
		available: !!warpRemoteBaseUrl || psmux.available,
		sameTailnet: isTailscaleIpv4(remoteAddress),
		requestRemoteAddress: remoteAddress,
		warpRemoteBaseUrl,
		warpUriScheme: getWarpUriScheme(),
		psmux,
	};
}

function listPsmuxSessions(): WarpControlSnapshot["psmux"] {
	const executable = getPsmuxExecutable();
	const sessionsResult = runPsmux(["list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}"]);
	if (!sessionsResult.ok) {
		return { available: false, executable, sessions: [], error: sessionsResult.error };
	}
	const sessions: WarpPsmuxSession[] = [];
	for (const line of splitOutputLines(sessionsResult.stdout)) {
		const parts = line.split("\t");
		const parsed = parts.length > 1 ? undefined : parsePsmuxSessionLine(line);
		const name = parts.length > 1 ? parts[0] : parsed?.name;
		if (!name) continue;
		sessions.push({
			name,
			attached: parts.length > 1 ? parts[2] : parsed?.attached,
			windows: listPsmuxWindows(name),
		});
	}
	return { available: true, executable, sessions };
}

function listPsmuxWindows(session: string): WarpPsmuxWindow[] {
	const windowsResult = runPsmux(["list-windows", "-t", session, "-F", "#{window_index}\t#{window_name}\t#{window_active}"]);
	if (!windowsResult.ok) return [];
	const windows: WarpPsmuxWindow[] = [];
	for (const line of splitOutputLines(windowsResult.stdout)) {
		const parts = line.split("\t");
		const parsed = parts.length > 1 ? undefined : parsePsmuxWindowLine(line);
		const index = parts.length > 1 ? parts[0] : parsed?.index;
		if (!index) continue;
		windows.push({
			session,
			index,
			name: (parts.length > 1 ? parts[1] : parsed?.name) || index,
			active: parts.length > 1 ? parts[2] === "1" : !!parsed?.active,
			panes: listPsmuxPanes(session, index),
		});
	}
	return windows;
}

function listPsmuxPanes(session: string, windowIndex: string): WarpPsmuxPane[] {
	const target = `${session}:${windowIndex}`;
	const panesResult = runPsmux(["list-panes", "-t", target, "-F", "#{pane_index}\t#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_title}"]);
	if (!panesResult.ok) return [];
	const panes: WarpPsmuxPane[] = [];
	for (const line of splitOutputLines(panesResult.stdout)) {
		const parts = line.split("\t");
		const parsed = parts.length > 1 ? undefined : parsePsmuxPaneLine(line);
		const pane = parts.length > 1 ? parts[0] : parsed?.pane;
		if (!pane) continue;
		panes.push({
			session,
			window: windowIndex,
			pane,
			paneId: (parts.length > 1 ? parts[1] : parsed?.paneId) || "",
			active: parts.length > 1 ? parts[2] === "1" : !!parsed?.active,
			command: parts.length > 1 ? parts[3] || undefined : undefined,
			title: parts.length > 1 ? parts[4] || undefined : undefined,
		});
	}
	return panes;
}

function parsePsmuxSessionLine(line: string) {
	const match = /^([^:]+):\s+(\d+)\s+windows?(?:\s+\(created\s+(.+)\))?/.exec(line);
	if (!match) return undefined;
	return { name: match[1], attached: undefined as string | undefined };
}

function parsePsmuxWindowLine(line: string) {
	const match = /^(\d+):\s+(.+?)(\*)?\s+\(\d+\s+panes?\)/.exec(line);
	if (!match) return undefined;
	return { index: match[1], name: match[2].trim(), active: match[3] === "*" };
}

function parsePsmuxPaneLine(line: string) {
	const match = /^(\d+):.*\s(%\d+)\s*(?:\((active)\))?/.exec(line);
	if (!match) return undefined;
	return { pane: match[1], paneId: match[2], active: match[3] === "active" };
}
function createPsmuxSession(payload: Record<string, unknown> | undefined): ControlActionResult {
	const name = typeof payload?.name === "string" ? payload.name.trim() : "";
	if (!isSafePsmuxName(name)) {
		return { ok: false, message: "Invalid psmux session name. Use 1-64 letters, numbers, dots, underscores, or dashes." };
	}
	const args = ["new-session", "-d", "-s", name];
	const cwd = normalizeExistingDirectory(typeof payload?.cwd === "string" ? payload.cwd : undefined);
	if (cwd) args.push("-c", cwd);
	const result = runPsmux(args);
	return result.ok
		? { ok: true, message: `Created psmux session ${name}.`, session: name }
		: { ok: false, message: result.error || "Failed to create psmux session." };
}

function createPsmuxWindow(payload: Record<string, unknown> | undefined): ControlActionResult {
	const session = typeof payload?.session === "string" ? payload.session.trim() : "";
	const name = typeof payload?.name === "string" ? payload.name.trim() : "";
	if (!isSafePsmuxName(session)) {
		return { ok: false, message: "Invalid psmux session target." };
	}
	if (name && !isSafePsmuxName(name)) {
		return { ok: false, message: "Invalid psmux window name. Use 1-64 letters, numbers, dots, underscores, or dashes." };
	}
	const args = ["new-window", "-t", session];
	if (name) args.push("-n", name);
	const cwd = normalizeExistingDirectory(typeof payload?.cwd === "string" ? payload.cwd : undefined);
	if (cwd) args.push("-c", cwd);
	const result = runPsmux(args);
	return result.ok
		? { ok: true, message: `Created psmux tab in ${session}.`, session, window: name || undefined }
		: { ok: false, message: result.error || "Failed to create psmux tab." };
}

function openWarpTab(payload: Record<string, unknown> | undefined): ControlActionResult {
	const cwd = normalizeExistingDirectory(typeof payload?.cwd === "string" ? payload.cwd : undefined) || getDefaultWorkspacePath();
	const newWindow = payload?.newWindow === true;
	const scheme = getWarpUriScheme();
	const action = newWindow ? "new_window" : "new_tab";
	const uri = `${scheme}://action/${action}?path=${encodeURIComponent(cwd)}`;
	const result = openLocalUri(uri);
	return result.ok
		? { ok: true, message: `Opened Warp ${newWindow ? "window" : "tab"}.`, uri, cwd }
		: { ok: false, message: result.error || "Failed to open Warp URI.", uri, cwd };
}

function openWarpTabConfig(payload: Record<string, unknown> | undefined): ControlActionResult {
	const name = typeof payload?.name === "string" ? payload.name.trim() : "";
	if (!isSafeWarpTabConfigName(name)) {
		return { ok: false, message: "Invalid Warp tab config name. Use a .toml file stem with letters, numbers, dots, underscores, or dashes." };
	}
	const newWindow = payload?.newWindow === true;
	const uri = `${getWarpUriScheme()}://tab_config/${encodeURIComponent(name)}${newWindow ? "?new_window=true" : ""}`;
	const result = openLocalUri(uri);
	return result.ok
		? { ok: true, message: `Opened Warp tab config ${name}.`, uri, name }
		: { ok: false, message: result.error || "Failed to open Warp tab config.", uri, name };
}

function getWarpUriScheme() {
	const configured = process.env.PI_SPEAK_WARP_URI_SCHEME?.trim();
	if (configured && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(configured)) return configured;
	return "warp";
}

function openLocalUri(uri: string) {
	const override = process.env.PI_SPEAK_WARP_OPEN_BIN?.trim();
	if (override) return runProcess(override, [uri], 3000);
	if (platform() === "win32") return runProcess("rundll32.exe", ["url.dll,FileProtocolHandler", uri], 3000);
	if (platform() === "darwin") return runProcess("open", [uri], 3000);
	return runProcess("xdg-open", [uri], 3000);
}

function getPsmuxExecutable() {
	return process.env.PI_SPEAK_PSMUX_BIN?.trim() || (platform() === "win32" ? "psmux.exe" : "tmux");
}

function runPsmux(args: string[]) {
	const executable = getPsmuxExecutable();
	const result = runProcess(executable, args, 3000);
	return result.ok
		? { ok: true as const, stdout: result.stdout, error: "" }
		: { ok: false as const, stdout: result.stdout, error: result.error };
}

function runProcess(executable: string, args: string[], timeout: number) {
	const result = spawnSync(executable, args, {
		encoding: "utf8",
		timeout,
		windowsHide: true,
	});
	if (result.error) {
		return { ok: false as const, stdout: "", error: result.error.message };
	}
	if (result.status !== 0) {
		const error = (result.stderr || result.stdout || `${executable} exited with ${result.status}`).trim();
		return { ok: false as const, stdout: result.stdout || "", error };
	}
	return { ok: true as const, stdout: result.stdout || "", error: "" };
}

function splitOutputLines(output: string) {
	return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isSafeWarpTabConfigName(value: string) {
	return /^[A-Za-z0-9_.-]{1,128}(?:\.toml)?$/.test(value) && !value.includes("..");
}

function isSafePsmuxName(value: string) {
	return /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

function normalizeExistingDirectory(value: string | undefined) {
	if (!value) return undefined;
	const resolved = resolve(value);
	return safeStatDirectory(resolved) ? resolved : undefined;
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

function parseAgentProviderOverride(value: string | null | undefined): GatewayAgentProvider | undefined {
	const normalized = (value || "").trim().toLowerCase();
	if (normalized === "pi" || normalized === "codex" || normalized === "claude") return normalized;
	if (normalized === "oh-my-pk" || normalized === "ompk" || normalized === "oh-my-pi" || normalized === "omp") return "oh-my-pk";
	return undefined;
}

function parseModelOverride(value: string | null | undefined): string | undefined {
	const trimmed = (value || "").trim();
	if (!trimmed || trimmed.length > 160 || /[\s\x00-\x1f\x7f]/.test(trimmed)) return undefined;
	return trimmed;
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


function isLocalRequest(req: IncomingMessage, url: URL) {
	const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
	const hostname = url.hostname;
	// Pure loopback — require both remote address and Host to be loopback
	if (isLoopback(remoteAddress) && isLoopbackHost(hostname)) return true;
	return false;
}

function isLoopbackHost(hostname: string) {
	const normalized = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isTailscaleDnsHost(host: string) {
	try {
		const hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return hostname.endsWith(".ts.net");
	} catch {
		return false;
	}
}

function renderConnectHtml({
	profileName,
	phoneBaseUrl,
	appSetupUrl,
	setupPageUrl,
	apkUrl,
	apkAvailable,
	reachableUrls,
	qrSvg,
}: {
	profileName: string;
	phoneBaseUrl: string;
	appSetupUrl: string;
	setupPageUrl: string;
	apkUrl: string;
	apkAvailable: boolean;
	reachableUrls: string[];
	qrSvg: string;
}): string {
	const reachableRows = reachableUrls
		.map((entry) => `<code>${escapeHtml(entry)}</code>`)
		.join(" ");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi Speak — Connect your phone</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
main { max-width: 640px; margin: 0 auto; padding: 40px 24px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: #8b949e; font-size: 14px; margin: 0 0 24px; }
.panel { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; }
.qr { display: flex; justify-content: center; margin: 20px 0; }
.qr > div { background: #ffffff; padding: 14px; border-radius: 10px; line-height: 0; }
.status { display: flex; align-items: center; gap: 10px; font-size: 15px; margin: 4px 0 12px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #d29922; animation: pulse 1.6s ease-in-out infinite; }
.dot.ok { background: #3fb950; animation: none; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.meta { font-size: 13px; color: #8b949e; overflow-wrap: anywhere; margin: 6px 0; }
code { background: #0d1117; border: 1px solid #30363d; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
button:hover { border-color: #8b949e; }
.steps { font-size: 14px; color: #c9d1d9; padding-left: 18px; margin: 0 0 8px; }
.steps li { margin: 4px 0; }
.footer { font-size: 12px; color: #6e7681; margin-top: 20px; }
</style>
</head>
<body>
<main>
<h1>Connect your phone</h1>
<p class="sub">${escapeHtml(profileName)} &middot; ${escapeHtml(phoneBaseUrl)}</p>
<section class="panel">
<div class="status"><span class="dot" id="dot"></span><span id="statusText">Waiting for your phone&hellip;</span></div>
<ol class="steps">
<li>Install the Pi Speak app on your Android phone${apkAvailable ? ` (<a href="${escapeHtml(apkUrl)}" style="color:#58a6ff">APK</a>)` : ""}.</li>
<li>Scan this QR code with the phone camera.</li>
<li>Tap the <code>pi-speak://</code> link — the app configures itself and connects.</li>
</ol>
<div class="qr"><div>${qrSvg}</div></div>
<p class="meta"><strong>No camera?</strong> Open <code id="setupUrl">${escapeHtml(setupPageUrl)}</code> on the phone <button onclick="copySetup()">Copy link</button></p>
<p class="meta"><strong>Reachable at:</strong> ${reachableRows || "<code>no LAN/Tailscale address found</code>"}</p>
</section>
<p class="footer">This page (and the token inside the QR) is only served to this machine. Keep this window open to see when the phone connects.</p>
</main>
<script>
var loadedAt = Date.now();
function copySetup() {
	var text = document.getElementById("setupUrl").textContent;
	if (navigator.clipboard) { navigator.clipboard.writeText(text); }
}
function poll() {
	fetch("/v1/pairing/status", { cache: "no-store" })
		.then(function (res) { return res.json(); })
		.then(function (data) {
			var client = data && data.lastRemoteClient;
			if (client && client.at >= loadedAt) {
				document.getElementById("dot").className = "dot ok";
				document.getElementById("statusText").textContent =
					"Phone connected (" + (client.address || "remote") + ")";
			}
		})
		.catch(function () {});
}
setInterval(poll, 2000);
poll();
</script>
</body>
</html>`;
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
	const explicit = process.env.PI_SPEAK_WORKSPACE_ROOT?.trim();
	if (explicit) {
		// "/" (or a drive root) is an explicit, deliberate opt-in to browse the whole filesystem.
		if (explicit === "fs" || explicit === "*") {
			return platform() === "win32" ? parse(process.cwd()).root || "C:\\" : "/";
		}
		return explicit;
	}
	// Default to the agent working directory rather than the whole drive. The
	// authenticated /v1/workspace/file route reads file CONTENT confined to this
	// root, so a permissive default would let any remote-token holder exfiltrate
	// arbitrary files (SSH keys, .env, the pi-speak token itself). Opt in to a
	// broader root with PI_SPEAK_WORKSPACE_ROOT (set it to "fs" for the drive root).
	return getDefaultWorkspacePath();
}

function getDefaultWorkspacePath() {
	return process.env.AGENT_CWD?.trim()
		|| process.env.AGENT_WORKSPACE?.trim()
		|| (platform() === "win32" ? DEFAULT_WINDOWS_WORKSPACE : "")
		|| process.cwd();
}

// Resolve symlinks/junctions and confirm the real path stays within the workspace
// root. resolve()/isPathInsideRoot() are purely lexical, but statSync/readSync follow
// links, so a link inside the root could otherwise expose files outside it. Returns the
// canonical path when contained, otherwise undefined.
function realPathInsideRoot(target: string, root: string): string | undefined {
	let realTarget: string;
	try {
		realTarget = realpathSync(target);
	} catch {
		return undefined;
	}
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		realRoot = resolve(root);
	}
	return isPathInsideRoot(realTarget, realRoot) ? realTarget : undefined;
}

const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
	"CON", "PRN", "AUX", "NUL",
	"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
	"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// Windows resolves names like CON / NUL / COM1 to console/serial devices regardless of
// directory, and reading one can block forever. Reject them before any stat/open.
function isWindowsReservedDeviceName(pathOrName: string) {
	if (platform() !== "win32") return false;
	const base = basename(pathOrName);
	const stem = base.split(".")[0].replace(/[ .]+$/, "").trim().toUpperCase();
	return WINDOWS_RESERVED_DEVICE_NAMES.has(stem);
}

const WORKSPACE_LIST_MAX_ENTRIES = 2000;

export function listWorkspaceDirectory(requestedPath?: string) {
	const root = resolve(getWorkspaceRoot());
	const requested = resolve(requestedPath?.trim() || root);
	// Lexical clamp first (cheap ../ guard), then confirm the real directory stays in
	// root so a symlinked subdirectory cannot walk outside it.
	const lexical = isPathInsideRoot(requested, root) ? requested : root;
	const current = safeStatDirectory(lexical) && realPathInsideRoot(lexical, root) ? lexical : root;
	const directories: WorkspaceEntry[] = [];
	const files: WorkspaceEntry[] = [];
	let truncated = false;
	try {
		const dir = opendirSync(current);
		try {
			// Stream entries with a hard cap so an enormous directory (node_modules,
			// WinSxS, ...) can't pin the event loop or balloon the response.
			let dirent = dir.readSync();
			while (dirent) {
				if (directories.length + files.length >= WORKSPACE_LIST_MAX_ENTRIES) {
					truncated = true;
					break;
				}
				const name = dirent.name;
				if (name !== "$RECYCLE.BIN" && name !== "System Volume Information") {
					const childPath = join(current, name);
					if (dirent.isDirectory()) {
						directories.push({ name, path: childPath, type: "directory" });
					} else if (dirent.isFile()) {
						let size: number | undefined;
						try {
							size = statSync(childPath).size;
						} catch {}
						files.push({ name, path: childPath, type: "file", size });
					}
				}
				dirent = dir.readSync();
			}
		} finally {
			dir.closeSync();
		}
	} catch {}
	directories.sort((left, right) => left.name.localeCompare(right.name));
	files.sort((left, right) => left.name.localeCompare(right.name));
	const parent = current !== root ? dirname(current) : undefined;
	return {
		root,
		current,
		parent: parent && isPathInsideRoot(parent, root) ? parent : undefined,
		defaultPath: getDefaultWorkspacePath(),
		entries: [...directories, ...files],
		truncated,
	};
}

const WORKSPACE_FILE_MAX_BYTES = 512 * 1024;

// Decode a (possibly mid-stream) byte slice as UTF-8. When the slice was truncated at the
// byte cap, drop a trailing partial multi-byte sequence so the preview doesn't end in U+FFFD.
function decodeTextPreview(buffer: Buffer, truncated: boolean): string {
	if (!truncated || buffer.length === 0) return buffer.toString("utf8");
	let i = buffer.length - 1;
	while (i >= 0 && (buffer[i] & 0xc0) === 0x80) i--; // skip continuation bytes (10xxxxxx)
	if (i < 0) return buffer.toString("utf8");
	const lead = buffer[i];
	let seqLen = 1;
	if ((lead & 0xe0) === 0xc0) seqLen = 2;
	else if ((lead & 0xf0) === 0xe0) seqLen = 3;
	else if ((lead & 0xf8) === 0xf0) seqLen = 4;
	const available = buffer.length - i;
	const end = available < seqLen ? i : buffer.length;
	return buffer.subarray(0, end).toString("utf8");
}

export type WorkspaceFileResult =
	| {
		ok: true;
		name: string;
		path: string;
		/** Symlink/junction-resolved canonical path, for callers that must gate on the real target rather than the (possibly innocuously-named) requested path. */
		realPath: string;
		size: number;
		truncated: boolean;
		binary: boolean;
		content: string;
	}
	| { ok: false; status: number; error: string };

export function readWorkspaceFile(requestedPath?: string): WorkspaceFileResult {
	const trimmed = requestedPath?.trim();
	if (!trimmed) {
		return { ok: false, status: 400, error: "A file path is required." };
	}
	const root = resolve(getWorkspaceRoot());
	const target = resolve(trimmed);
	if (!isPathInsideRoot(target, root)) {
		return { ok: false, status: 403, error: "Path is outside the workspace root." };
	}
	if (isWindowsReservedDeviceName(target)) {
		return { ok: false, status: 400, error: "Path is not a regular file." };
	}
	let stats;
	try {
		stats = statSync(target);
	} catch {
		return { ok: false, status: 404, error: "File not found." };
	}
	if (stats.isDirectory()) {
		return { ok: false, status: 400, error: "Path is a directory, not a file." };
	}
	if (!stats.isFile()) {
		return { ok: false, status: 400, error: "Path is not a regular file." };
	}
	// Symlink/junction hardening: the real (link-resolved) path must also stay in root.
	const realTarget = realPathInsideRoot(target, root);
	if (!realTarget) {
		return { ok: false, status: 403, error: "Path is outside the workspace root." };
	}
	let buffer: Buffer;
	try {
		const fd = openSync(target, "r");
		try {
			const readLength = Math.min(stats.size, WORKSPACE_FILE_MAX_BYTES);
			const scratch = Buffer.alloc(readLength);
			const bytes = readSync(fd, scratch, 0, readLength, 0);
			buffer = scratch.subarray(0, bytes);
		} finally {
			closeSync(fd);
		}
	} catch {
		return { ok: false, status: 500, error: "Unable to read file." };
	}
	const binary = buffer.includes(0);
	const truncated = stats.size > buffer.length;
	return {
		ok: true,
		name: basename(target),
		path: target,
		realPath: realTarget,
		size: stats.size,
		truncated,
		binary,
		content: binary ? "" : decodeTextPreview(buffer, truncated),
	};
}

function readCollabLink(): CollabLinkSnapshot {
	try {
		const file = join(getPiSpeakConfigDir(), "collab.json");
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { active: false };
		}
		const snapshot: CollabLinkSnapshot = { active: !!parsed.active };
		if (typeof parsed.webLink === "string") snapshot.webLink = parsed.webLink;
		if (typeof parsed.webViewLink === "string") snapshot.webViewLink = parsed.webViewLink;
		if (typeof parsed.link === "string") snapshot.link = parsed.link;
		if (typeof parsed.viewLink === "string") snapshot.viewLink = parsed.viewLink;
		if (typeof parsed.view === "boolean") snapshot.view = parsed.view;
		if (typeof parsed.startedAt === "string") snapshot.startedAt = parsed.startedAt;
		return snapshot;
	} catch {
		return { active: false };
	}
}

function getStableServerId() {
	const explicit = process.env.PI_SPEAK_SERVER_ID?.trim();
	if (explicit) return explicit;
	return hostname() || "pi-speak";
}

function safeStatDirectory(path: string) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isPathInsideRoot(path: string, root: string) {
	// Case-fold only on Windows; POSIX filesystems are case-sensitive and folding there
	// would conflate distinct directories (e.g. /srv/Data vs /srv/data).
	const caseFold = platform() === "win32";
	const normalizedPath = caseFold ? resolve(path).toLowerCase() : resolve(path);
	const normalizedRoot = caseFold ? resolve(root).toLowerCase() : resolve(root);
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

function mimeTypeToExtension(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "audio/mpeg":
		case "audio/mp3":
			return "mp3";
		case "audio/wav":
		case "audio/x-wav":
			return "wav";
		case "audio/ogg":
			return "ogg";
		case "audio/webm":
			return "webm";
		default:
			return "bin";
	}
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
