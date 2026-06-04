export type AgentProviderName = "pi" | "codex" | "claude" | "gemini" | "gemini-live" | "elevenlabs";

export type AgentPromptMode = "turn" | "steer" | "followUp";

export type AgentPromptOptions = {
	mode?: AgentPromptMode;
	model?: string;
	cwd?: string;
	timeoutMs?: number;
	instructions?: string;
};

export type AgentResponseChunk = {
	type: "text";
	text: string;
};

export type AgentProviderCapabilities = {
	textTurns: boolean;
	voiceTurns: boolean;
	audioReplies: boolean;
	routing: boolean;
	steering: boolean;
	resumableSessions: boolean;
};

export interface AgentProvider {
	readonly name: AgentProviderName;
	readonly capabilities?: Partial<AgentProviderCapabilities>;
	start?(): Promise<void>;
	stop?(): Promise<void>;
	sendPrompt(prompt: string, options?: AgentPromptOptions): AsyncIterable<AgentResponseChunk>;
}

export type AgentProviderConfig = {
	provider: AgentProviderName;
	codexBin: string;
	claudeBin: string;
	piBin: string;
	model?: string;
	approvalPolicy: string;
	sandbox: string;
};

export function resolveAgentProviderConfig(env: NodeJS.ProcessEnv = process.env): AgentProviderConfig {
	const configuredProvider = (env.AGENT_PROVIDER || "pi").trim().toLowerCase();
	const provider: AgentProviderName = configuredProvider === "codex"
		? "codex"
		: configuredProvider === "claude"
			? "claude"
		: configuredProvider === "gemini" || configuredProvider === "gemini-live"
			? configuredProvider
			: configuredProvider === "elevenlabs"
				? "elevenlabs"
			: "pi";
	const model = env.AGENT_MODEL?.trim() || undefined;
	return {
		provider,
		codexBin: env.CODEX_BIN?.trim() || "codex",
		claudeBin: env.CLAUDE_BIN?.trim() || "claude",
		piBin: env.PI_BIN?.trim() || "pi",
		model,
		approvalPolicy: env.AGENT_APPROVAL_POLICY?.trim() || env.CODEX_APPROVAL_POLICY?.trim() || "never",
		sandbox: env.AGENT_SANDBOX?.trim() || env.CODEX_SANDBOX?.trim() || "danger-full-access",
	};
}

export async function collectAgentResponse(
	provider: AgentProvider,
	prompt: string,
	options: AgentPromptOptions = {},
	onChunk?: (chunk: AgentResponseChunk) => void,
): Promise<string> {
	let text = "";
	for await (const chunk of provider.sendPrompt(prompt, options)) {
		if (chunk.type !== "text" || !chunk.text) continue;
		text += chunk.text;
		onChunk?.(chunk);
	}
	return text.trim();
}

export function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}
