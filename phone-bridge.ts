import { createReadStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename } from "node:path";

export type PhoneBridgeState = {
	enabled: boolean;
	linkedChatId?: string;
	linkCode?: string;
	lastUpdateId?: number;
};

export type PhoneTurnResult = {
	replyText: string;
	audioPath?: string;
	audioMimeType?: string;
	transcript?: string;
};

export type TelegramPhoneBridgeOptions = {
	token: string;
	state: PhoneBridgeState;
	getStatusText: () => string;
	onStateChange: (state: Partial<PhoneBridgeState>) => void;
	onTextTurn: (text: string) => Promise<PhoneTurnResult>;
	onVoiceBuffer: (buffer: Buffer, mimeType?: string) => Promise<PhoneTurnResult>;
};

type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
};

type TelegramMessage = {
	message_id: number;
	chat: { id: number | string };
	text?: string;
	voice?: { file_id: string; mime_type?: string };
	audio?: { file_id: string; mime_type?: string };
};

export class TelegramPhoneBridge {
	private readonly token: string;
	private readonly getStatusText: () => string;
	private readonly onStateChange: (state: Partial<PhoneBridgeState>) => void;
	private readonly onTextTurn: (text: string) => Promise<PhoneTurnResult>;
	private readonly onVoiceBuffer: (buffer: Buffer, mimeType?: string) => Promise<PhoneTurnResult>;
	private linkCode: string;
	private linkedChatId?: string;
	private lastUpdateId?: number;
	private running = false;
	private loopPromise?: Promise<void>;

	constructor(options: TelegramPhoneBridgeOptions) {
		this.token = options.token;
		this.getStatusText = options.getStatusText;
		this.onStateChange = options.onStateChange;
		this.onTextTurn = options.onTextTurn;
		this.onVoiceBuffer = options.onVoiceBuffer;
		this.linkCode = options.state.linkCode || generateLinkCode();
		this.linkedChatId = options.state.linkedChatId;
		this.lastUpdateId = options.state.lastUpdateId;
	}

	start() {
		if (this.running) return;
		this.running = true;
		this.onStateChange({ enabled: true, linkCode: this.linkCode, linkedChatId: this.linkedChatId });
		this.loopPromise = this.pollLoop();
	}

	async stop() {
		this.running = false;
		await this.loopPromise?.catch(() => {});
		this.loopPromise = undefined;
		this.onStateChange({ enabled: false, linkCode: this.linkCode, linkedChatId: this.linkedChatId });
	}

	getStatus() {
		return {
			running: this.running,
			linkedChatId: this.linkedChatId,
			linkCode: this.linkCode,
			lastUpdateId: this.lastUpdateId,
		};
	}

	resetLink() {
		this.linkCode = generateLinkCode();
		this.linkedChatId = undefined;
		this.onStateChange({ linkCode: this.linkCode, linkedChatId: undefined });
		return this.linkCode;
	}

	private async pollLoop() {
		while (this.running) {
			try {
				const updates = await this.getUpdates();
				for (const update of updates) {
					this.lastUpdateId = update.update_id;
					this.onStateChange({ lastUpdateId: this.lastUpdateId });
					await this.handleUpdate(update);
				}
			} catch (error) {
				await this.delay(2500);
			}
		}
	}

	private async handleUpdate(update: TelegramUpdate) {
		const message = update.message;
		if (!message) return;
		const chatId = String(message.chat.id);

		if (!this.linkedChatId) {
			const text = message.text?.trim() || "";
			if (text.toLowerCase() === `/link ${this.linkCode.toLowerCase()}`) {
				this.linkedChatId = chatId;
				this.onStateChange({ linkedChatId: chatId });
				await this.sendMessage(chatId, "Phone bridge linked. Send text or voice messages to Pi.");
			} else if (text.startsWith("/link ")) {
				await this.sendMessage(chatId, "Link code rejected.");
			}
			return;
		}

		if (chatId !== this.linkedChatId) return;

		const text = message.text?.trim();
		if (text) {
			if (text === "/status") {
				await this.sendMessage(chatId, this.getStatusText());
				return;
			}
			if (text === "/unpair") {
				this.resetLink();
				await this.sendMessage(chatId, "Phone bridge unpaired.");
				return;
			}
			if (text === "/help") {
				await this.sendMessage(
					chatId,
					"Send text or a voice note. Use /status to inspect the bridge, /unpair to revoke this phone, and /help to see this message again.",
				);
				return;
			}
			await this.sendChatAction(chatId, "typing");
			const result = await this.onTextTurn(text);
			await this.deliverResult(chatId, result);
			return;
		}

		const fileId = message.voice?.file_id || message.audio?.file_id;
		if (!fileId) return;
		const mimeType = message.voice?.mime_type || message.audio?.mime_type;
		await this.sendChatAction(chatId, "typing");
		const buffer = await this.downloadFile(fileId);
		const result = await this.onVoiceBuffer(buffer, mimeType);
		await this.deliverResult(chatId, result);
	}

	private async deliverResult(chatId: string, result: PhoneTurnResult) {
		if (result.audioPath) {
			try {
				await this.sendAudio(chatId, result.audioPath);
			} finally {
				await rm(result.audioPath, { force: true });
			}
		}
		const text = result.transcript
			? `Heard: "${result.transcript}"\n\n${result.replyText}`
			: result.replyText;
		if (text.trim()) {
			await this.sendMessage(chatId, text);
		}
	}

	private async getUpdates() {
		const body = new URLSearchParams();
		if (typeof this.lastUpdateId === "number") body.set("offset", String(this.lastUpdateId + 1));
		body.set("timeout", "25");
		const json = await this.callApi<{ ok: boolean; result: TelegramUpdate[] }>("getUpdates", body);
		return json.result || [];
	}

	private async downloadFile(fileId: string) {
		const fileInfo = await this.callApi<{ ok: boolean; result: { file_path: string } }>(
			"getFile",
			new URLSearchParams({ file_id: fileId }),
		);
		const filePath = fileInfo.result?.file_path;
		if (!filePath) throw new Error("Telegram did not return a file path");
		const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
		if (!response.ok) {
			throw new Error(`Failed to download Telegram file (${response.status})`);
		}
		return Buffer.from(await response.arrayBuffer());
	}

	private async sendMessage(chatId: string, text: string) {
		const body = new URLSearchParams({
			chat_id: chatId,
			text: text.slice(0, 4000),
		});
		await this.callApi("sendMessage", body);
	}

	private async sendChatAction(chatId: string, action: "typing" | "upload_voice" | "upload_document") {
		const body = new URLSearchParams({
			chat_id: chatId,
			action,
		});
		await this.callApi("sendChatAction", body);
	}

	private async sendAudio(chatId: string, filePath: string) {
		const isVoice = filePath.toLowerCase().endsWith(".ogg") || filePath.toLowerCase().endsWith(".oga");
		await this.sendChatAction(chatId, isVoice ? "upload_voice" : "upload_document");
		const form = new FormData();
		form.set("chat_id", chatId);
		form.set(
			isVoice ? "voice" : "audio",
			new File([await readFile(filePath)], basename(filePath), {
				type: isVoice ? "audio/ogg" : "audio/mpeg",
			}),
		);
		await this.callApi(isVoice ? "sendVoice" : "sendAudio", form);
	}

	private async callApi<T = unknown>(method: string, body: URLSearchParams | FormData) {
		const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
			method: "POST",
			body,
		});
		if (!response.ok) {
			throw new Error(`Telegram ${method} failed (${response.status})`);
		}
		return (await response.json()) as T;
	}

	private async delay(ms: number) {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}
}

function generateLinkCode() {
	return String(Math.floor(100000 + Math.random() * 900000));
}
