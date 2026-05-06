import type { AgentProvider, AgentPromptOptions, AgentResponseChunk } from "./agent-provider.js";
import { AsyncQueue } from "./async-queue.js";

export type PiSendUserMessage = (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;

export type PiAgentProviderOptions = {
	sendUserMessage: PiSendUserMessage;
};

type ActivePiTurn = {
	queue: AsyncQueue<AgentResponseChunk>;
	streamedText: string;
	finalText?: string;
};

type AssistantMessageEvent = {
	type?: string;
	delta?: string;
	text?: string;
};

export class PiAgentProvider implements AgentProvider {
	readonly name = "pi" as const;
	private activeTurn?: ActivePiTurn;

	constructor(private readonly options: PiAgentProviderOptions) {}

	async *sendPrompt(prompt: string, options: AgentPromptOptions = {}): AsyncIterable<AgentResponseChunk> {
		if (this.activeTurn) {
			const mode = options.mode === "steer" ? "steer" : "followUp";
			this.options.sendUserMessage(prompt, { deliverAs: mode });
			return;
		}

		const activeTurn: ActivePiTurn = {
			queue: new AsyncQueue<AgentResponseChunk>(),
			streamedText: "",
		};
		this.activeTurn = activeTurn;
		this.options.sendUserMessage(prompt, options.mode && options.mode !== "turn" ? { deliverAs: options.mode } : undefined);

		try {
			for await (const chunk of activeTurn.queue) {
				yield chunk;
			}
		} finally {
			if (this.activeTurn === activeTurn) this.activeTurn = undefined;
		}
	}

	handleMessageUpdate(event: { assistantMessageEvent?: AssistantMessageEvent }) {
		if (!this.activeTurn) return;
		const delta = extractAssistantDelta(event.assistantMessageEvent);
		if (!delta) return;
		this.activeTurn.streamedText += delta;
		this.activeTurn.queue.push({ type: "text", text: delta });
	}

	handleMessageEnd(text: string) {
		if (!this.activeTurn || !text.trim()) return;
		this.activeTurn.finalText = text;
		if (!this.activeTurn.streamedText.trim()) {
			this.activeTurn.streamedText = text;
			this.activeTurn.queue.push({ type: "text", text });
		}
	}

	handleAgentEnd() {
		if (!this.activeTurn) return;
		if (!this.activeTurn.streamedText.trim() && this.activeTurn.finalText?.trim()) {
			this.activeTurn.queue.push({ type: "text", text: this.activeTurn.finalText });
		}
		this.activeTurn.queue.close();
	}

	handleAgentError(error: Error) {
		this.activeTurn?.queue.fail(error);
		this.activeTurn = undefined;
	}
}

function extractAssistantDelta(event: AssistantMessageEvent | undefined) {
	if (!event || typeof event !== "object") return "";
	if (typeof event.delta === "string") return event.delta;
	if (event.type === "text_delta" && typeof event.text === "string") return event.text;
	return "";
}
