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
	httpPort?: string;
	httpToken?: string;
	publicBaseUrl?: string;
	trayBaseUrl?: string;
	installMobileApp?: boolean;
	preferTray?: boolean;
	updatedAt?: string;
};

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
	writeFileSync(configPath, `${JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return configPath;
}

export function applyPiSpeakSetupConfig(env: NodeJS.ProcessEnv = process.env, config = loadPiSpeakSetupConfig(env)) {
	for (const [configKey, envKey] of ENV_TO_CONFIG) {
		const value = config[configKey];
		if (typeof value === "string" && value.trim() && !env[envKey]) {
			env[envKey] = value.trim();
		}
	}
	return env;
}

export function buildPiSpeakEnv(baseEnv: NodeJS.ProcessEnv = process.env, config = loadPiSpeakSetupConfig(baseEnv)) {
	const env = { ...baseEnv };
	return applyPiSpeakSetupConfig(env, config);
}

export function maskSecret(value: string | undefined) {
	if (!value) return "";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
