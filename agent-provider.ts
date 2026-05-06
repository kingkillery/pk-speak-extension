export type AgentProviderName = "pi" | "codex";

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

export interface AgentProvider {
	readonly name: AgentProviderName;
	start?(): Promise<void>;
	stop?(): Promise<void>;
	sendPrompt(prompt: string, options?: AgentPromptOptions): AsyncIterable<AgentResponseChunk>;
}

export type AgentProviderConfig = {
	provider: AgentProviderName;
	codexBin: string;
	piBin: string;
	model?: string;
};

export function resolveAgentProviderConfig(env: NodeJS.ProcessEnv = process.env): AgentProviderConfig {
	const configuredProvider = (env.AGENT_PROVIDER || "pi").trim().toLowerCase();
	const provider: AgentProviderName = configuredProvider === "codex" ? "codex" : "pi";
	const model = env.AGENT_MODEL?.trim() || undefined;
	return {
		provider,
		codexBin: env.CODEX_BIN?.trim() || "codex",
		piBin: env.PI_BIN?.trim() || "pi",
		model,
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
