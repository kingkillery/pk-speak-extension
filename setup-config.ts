import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PiSpeakSetupConfig = {
	agentProvider?: string;
	executionRouterMode?: string;
	ttsProvider?: string;
	speakPlaybackGate?: string;
	elevenLabsApiKey?: string;
	elevenLabsVoiceId?: string;
	elevenLabsModelId?: string;
	openAiKey?: string;
	openAiTtsModel?: string;
	openAiVoice?: string;
	geminiBackend?: string;
	vertexApiKey?: string;
	geminiTextModel?: string;
	geminiLiveModel?: string;
	minimaxApiKey?: string;
	minimaxVoiceId?: string;
	minimaxModel?: string;
	remoteSttProvider?: string;
	remoteSttBackend?: string;
	httpPort?: string;
	httpToken?: string;
	/** Telegram bot credential used by the standalone headless gateway. */
	telegramBotToken?: string;
	/** Durable Telegram pairing state (never includes the bot credential). */
	phoneState?: {
		enabled?: boolean;
		linkedChatId?: string;
		linkCode?: string;
		lastUpdateId?: number;
		lastPollAt?: number;
		consecutivePollFailures?: number;
		lastError?: string;
		linkAttempts?: number;
		linkLockoutUntil?: number;
		linkCodeIssuedAt?: number;
	};
	publicBaseUrl?: string;
	trayBaseUrl?: string;
	installMobileApp?: boolean;
	preferTray?: boolean;
	updatedAt?: string;
	/**
	 * Schema version stamp written by savePiSpeakSetupConfig. Missing or
	 * older values indicate a legacy persisted config that may carry defaults
	 * the operator never explicitly chose (e.g. speakPlaybackGate="immediate"
	 * before the interactive orb default shipped).
	 */
	configSchemaVersion?: number;
};

/**
 * Current setup-config schema version. Bump when the persisted defaults
 * change semantically; applyPiSpeakSetupConfig only migrates configs whose
 * configSchemaVersion is missing or older than this.
 */
export const CURRENT_PI_SPEAK_CONFIG_SCHEMA_VERSION = 1;

const ENV_TO_CONFIG: Array<[keyof PiSpeakSetupConfig, string]> = [
	["agentProvider", "AGENT_PROVIDER"],
	["executionRouterMode", "PI_SPEAK_EXECUTION_ROUTER_MODE"],
	["ttsProvider", "PI_SPEAK_TTS_PROVIDER"],
	["speakPlaybackGate", "PI_SPEAK_PLAYBACK_GATE"],
	["elevenLabsApiKey", "ELEVENLABS_API_KEY"],
	["elevenLabsVoiceId", "PI_SPEAK_ELEVENLABS_VOICE_ID"],
	["elevenLabsModelId", "PI_SPEAK_ELEVENLABS_MODEL_ID"],
	["openAiKey", "PI_SPEAK_OPENAI_KEY"],
	["openAiTtsModel", "PI_SPEAK_OPENAI_TTS_MODEL"],
	["openAiVoice", "PI_SPEAK_OPENAI_VOICE"],
	["geminiBackend", "PI_SPEAK_GEMINI_BACKEND"],
	["vertexApiKey", "PI_SPEAK_VERTEX_API_KEY"],
	["geminiTextModel", "PI_SPEAK_GEMINI_TEXT_MODEL"],
	["geminiLiveModel", "PI_SPEAK_GEMINI_LIVE_MODEL"],
	["minimaxApiKey", "MINIMAX_API_KEY"],
	["minimaxVoiceId", "PI_SPEAK_MINIMAX_VOICE_ID"],
	["minimaxModel", "PI_SPEAK_MINIMAX_MODEL"],
	["remoteSttProvider", "PI_SPEAK_REMOTE_STT_PROVIDER"],
	["remoteSttBackend", "PI_SPEAK_REMOTE_STT_BACKEND"],
	["httpPort", "PI_SPEAK_HTTP_PORT"],
	["httpToken", "PI_SPEAK_HTTP_TOKEN"],
	["publicBaseUrl", "PI_SPEAK_PUBLIC_BASE_URL"],
	["trayBaseUrl", "PI_SPEAK_TRAY_BASE_URL"],
];

export function getPiSpeakConfigDir(env: NodeJS.ProcessEnv = process.env) {
	return env.PI_SPEAK_CONFIG_DIR
		|| env.LOCALAPPDATA && join(env.LOCALAPPDATA, "pi-speak")
		|| env.APPDATA && join(env.APPDATA, "pi-speak")
		|| join(homedir(), ".pi-speak");
}

export function getPiSpeakSetupConfigPath(env: NodeJS.ProcessEnv = process.env) {
	return join(getPiSpeakConfigDir(env), "setup.json");
}

export function loadPiSpeakSetupConfig(env: NodeJS.ProcessEnv = process.env): PiSpeakSetupConfig {
	const configPath = getPiSpeakSetupConfigPath(env);
	if (!existsSync(configPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as PiSpeakSetupConfig;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function savePiSpeakSetupConfig(config: PiSpeakSetupConfig, env: NodeJS.ProcessEnv = process.env) {
	const configPath = getPiSpeakSetupConfigPath(env);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify({ ...config, configSchemaVersion: CURRENT_PI_SPEAK_CONFIG_SCHEMA_VERSION, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return configPath;
}

export function applyPiSpeakSetupConfig(env: NodeJS.ProcessEnv = process.env, config = loadPiSpeakSetupConfig(env)) {
	// Capture which env keys the operator already set this session, so the
	// legacy-default migration below can't be defeated by the ENV_TO_CONFIG
	// loop copying a persisted "immediate" into env immediately before the
	// migration check runs.
	const explicitEnvKeys = new Set<string>();
	for (const key of Object.keys(env)) {
		if (typeof env[key] === "string" && (env[key] as string).trim()) explicitEnvKeys.add(key);
	}
	for (const [configKey, envKey] of ENV_TO_CONFIG) {
		const value = config[configKey];
		if (typeof value === "string" && value.trim() && !explicitEnvKeys.has(envKey)) {
			// Legacy-default migration: setups persisted before the interactive
			// orb default shipped (configSchemaVersion missing or < 1) stored
			// speakPlaybackGate="immediate", which meant terminal auto-play —
			// exactly the behavior operators asked us to stop shipping as the
			// default. Force-upgrade that legacy value to "orb". Current-version
			// configs are never rewritten: if the operator deliberately chose
			// "immediate" via the current setup UI, their choice wins.
			const isLegacy = (config.configSchemaVersion ?? 0) < CURRENT_PI_SPEAK_CONFIG_SCHEMA_VERSION;
			if (isLegacy && configKey === "speakPlaybackGate" && value.trim() === "immediate") {
				env[envKey] = "orb";
			} else {
				env[envKey] = value.trim();
			}
		}
	}
	return env;
}

export function buildPiSpeakEnv(baseEnv: NodeJS.ProcessEnv = process.env, config = loadPiSpeakSetupConfig(baseEnv)) {
	const env = { ...baseEnv };
	return applyPiSpeakSetupConfig(env, config);
}

export function resolveTelegramBotToken(
	env: NodeJS.ProcessEnv = process.env,
	config = loadPiSpeakSetupConfig(env),
) {
	return env.PI_SPEAK_TELEGRAM_BOT_TOKEN?.trim()
		|| env.TELEGRAM_BOT_TOKEN?.trim()
		|| config.telegramBotToken?.trim()
		|| "";
}

export function maskSecret(value: string | undefined) {
	if (!value) return "";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
