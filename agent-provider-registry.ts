import type { AgentProviderCapabilities, AgentProviderName } from "./agent-provider.js";

export type RunnableAgentProviderName = Extract<AgentProviderName, "pi" | "codex" | "claude">;

export type AgentProviderSpec = {
	name: AgentProviderName;
	displayName: string;
	aliases: string[];
	defaultExecutable?: string;
	executableEnv?: string;
	capabilities: AgentProviderCapabilities;
	canResumeSession(sessionId?: string): boolean;
	buildResumeArgs?(sessionId: string, cwd?: string): string[];
};

const BASE_CAPABILITIES: AgentProviderCapabilities = {
	textTurns: true,
	voiceTurns: true,
	audioReplies: true,
	routing: true,
	steering: false,
	resumableSessions: false,
};

const AGENT_PROVIDER_SPECS: Record<AgentProviderName, AgentProviderSpec> = {
	pi: {
		name: "pi",
		displayName: "Pi",
		aliases: ["pi", "pi-coding-agent"],
		defaultExecutable: "pi",
		executableEnv: "PI_BIN",
		capabilities: { ...BASE_CAPABILITIES },
		canResumeSession: () => false,
	},
	codex: {
		name: "codex",
		displayName: "Codex",
		aliases: ["codex", "openai codex"],
		defaultExecutable: "codex",
		executableEnv: "CODEX_BIN",
		capabilities: {
			...BASE_CAPABILITIES,
			steering: true,
			resumableSessions: true,
		},
		canResumeSession: (sessionId) => !!sessionId?.trim(),
		buildResumeArgs: (sessionId, cwd) => {
			const args = ["resume"];
			if (cwd) args.push("-C", cwd);
			args.push(sessionId);
			return args;
		},
	},
	claude: {
		name: "claude",
		displayName: "Claude",
		aliases: ["claude", "claude code"],
		defaultExecutable: "claude",
		executableEnv: "CLAUDE_BIN",
		capabilities: {
			...BASE_CAPABILITIES,
			resumableSessions: true,
		},
		canResumeSession: (sessionId) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId?.trim() || ""),
		buildResumeArgs: (sessionId) => ["--resume", sessionId],
	},
	gemini: {
		name: "gemini",
		displayName: "Gemini",
		aliases: ["gemini"],
		capabilities: { ...BASE_CAPABILITIES, routing: false },
		canResumeSession: () => false,
	},
	"gemini-live": {
		name: "gemini-live",
		displayName: "Gemini Live",
		aliases: ["gemini-live", "gemini live"],
		capabilities: { ...BASE_CAPABILITIES, routing: false },
		canResumeSession: () => false,
	},
	elevenlabs: {
		name: "elevenlabs",
		displayName: "ElevenLabs",
		aliases: ["elevenlabs", "eleven labs"],
		capabilities: { ...BASE_CAPABILITIES },
		canResumeSession: () => false,
	},
};

export function normalizeAgentProviderName(value: string | undefined): AgentProviderName | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	for (const spec of Object.values(AGENT_PROVIDER_SPECS)) {
		if (spec.name === normalized || spec.aliases.includes(normalized)) return spec.name;
	}
	return undefined;
}

export function normalizeRunnableAgentProviderName(value: string | undefined): RunnableAgentProviderName | undefined {
	const normalized = normalizeAgentProviderName(value);
	return normalized === "pi" || normalized === "codex" || normalized === "claude" ? normalized : undefined;
}

export function getAgentProviderSpec(name: AgentProviderName): AgentProviderSpec {
	return AGENT_PROVIDER_SPECS[name];
}

export function getAgentProviderCapabilities(name: AgentProviderName): AgentProviderCapabilities {
	return { ...getAgentProviderSpec(name).capabilities };
}

export function isResumableAgentSession(provider: string | undefined, sessionId: string | undefined): boolean {
	const normalized = normalizeAgentProviderName(provider);
	if (!normalized) return false;
	return getAgentProviderSpec(normalized).canResumeSession(sessionId);
}

export function buildAgentResumeArgs(provider: string, sessionId: string, cwd?: string): string[] | undefined {
	const normalized = normalizeAgentProviderName(provider);
	if (!normalized) return undefined;
	const spec = getAgentProviderSpec(normalized);
	if (!spec.buildResumeArgs || !spec.canResumeSession(sessionId)) return undefined;
	return spec.buildResumeArgs(sessionId.trim(), cwd?.trim() || undefined);
}

export function buildAgentResumeCommandPreview(
	provider: string | undefined,
	sessionId: string | undefined,
	executable: string | undefined,
	cwd?: string,
): string[] | undefined {
	if (!provider || !sessionId || !executable || !isResumableAgentSession(provider, sessionId)) return undefined;
	const args = buildAgentResumeArgs(provider, sessionId, cwd);
	return args ? [executable, ...args] : undefined;
}
