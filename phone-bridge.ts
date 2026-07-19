import { randomInt } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename } from "node:path";
import { RemoteTurnResult } from "./remote-turn-manager.js";
import { withAbortTimeout } from "./request-timeout.js";

export type PhoneBridgeState = {
	enabled: boolean;
	botToken?: string;
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

export type TelegramPhoneBridgeOptions = {
	token: string;
	state: PhoneBridgeState;
	getStatusText: () => string;
	onStateChange: (state: Partial<PhoneBridgeState>) => void;
	onTextTurn: (text: string) => Promise<RemoteTurnResult>;
	onVoiceBuffer: (buffer: Buffer, mimeType?: string) => Promise<RemoteTurnResult>;
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
	private readonly onTextTurn: (text: string) => Promise<RemoteTurnResult>;
	private readonly onVoiceBuffer: (buffer: Buffer, mimeType?: string) => Promise<RemoteTurnResult>;
	private linkCode: string;
	private linkedChatId?: string;
	private lastUpdateId?: number;
	private lastPollAt?: number;
	private consecutivePollFailures = 0;
	private lastError?: string;
	private linkAttempts = 0;
	private linkLockoutUntil?: number;
	private linkCodeIssuedAt: number;
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
		this.lastPollAt = options.state.lastPollAt;
		this.consecutivePollFailures = options.state.consecutivePollFailures || 0;
		this.lastError = options.state.lastError;
		this.linkAttempts = options.state.linkAttempts || 0;
		this.linkLockoutUntil = options.state.linkLockoutUntil;
		this.linkCodeIssuedAt = options.state.linkCodeIssuedAt || Date.now();
	}

	start() {
		if (this.running) return;
		this.running = true;
		this.onStateChange(this.getStatePatch({ enabled: true }));
		this.loopPromise = this.pollLoop();
	}

	async stop() {
		this.running = false;
		await this.loopPromise?.catch(() => {});
		this.loopPromise = undefined;
		this.onStateChange(this.getStatePatch({ enabled: false }));
	}

	getStatus() {
		return {
			running: this.running,
			linkedChatId: this.linkedChatId,
			linkCode: this.linkCode,
			lastUpdateId: this.lastUpdateId,
			lastPollAt: this.lastPollAt,
			consecutivePollFailures: this.consecutivePollFailures,
			lastError: this.lastError,
			linkLockoutUntil: this.linkLockoutUntil,
		};
	}

	resetLink() {
		this.linkedChatId = undefined;
		this.rotateLinkCode();
		return this.linkCode;
	}

	// Issue a fresh link code and reset the brute-force counters. Used on manual
	// reset/unpair and whenever a code expires or is burned by too many failed
	// attempts. Clears any active lockout — a freshly-issued code must be usable
	// immediately, not blocked by a lockout window from the code it replaced.
	private rotateLinkCode() {
		this.linkCode = generateLinkCode();
		this.linkCodeIssuedAt = Date.now();
		this.linkAttempts = 0;
		this.linkLockoutUntil = undefined;
		this.onStateChange(this.getStatePatch());
	}

	private async pollLoop() {
		while (this.running) {
			try {
				const updates = await this.getUpdates();
				this.lastPollAt = Date.now();
				this.consecutivePollFailures = 0;
				this.lastError = undefined;
				this.onStateChange(this.getStatePatch());
				for (const update of updates) {
					this.lastUpdateId = update.update_id;
					this.onStateChange(this.getStatePatch({ lastUpdateId: this.lastUpdateId }));
					await this.handleUpdate(update);
				}
				if (updates.length === 0) {
					await this.delay(50);
				}
			} catch (error) {
				this.consecutivePollFailures += 1;
				this.lastError = error instanceof Error ? error.message : String(error);
				this.onStateChange(this.getStatePatch());
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
			const now = Date.now();
			if (now < (this.linkLockoutUntil ?? 0)) {
				if (text.startsWith("/link ")) {
					await this.sendMessage(chatId, "Too many attempts. Try again later.");
				}
				return;
			}
			// A stale code silently rotates so it can't be brute-forced forever.
			if (now - this.linkCodeIssuedAt > LINK_CODE_TTL_MS) {
				this.rotateLinkCode();
			}
			if (text.toLowerCase() === `/link ${this.linkCode.toLowerCase()}`) {
				this.linkedChatId = chatId;
				this.linkAttempts = 0;
				this.onStateChange(this.getStatePatch({ linkedChatId: chatId }));
				await this.sendMessage(chatId, "Phone bridge linked. Send text or voice messages to Pi.");
			} else if (text.startsWith("/link ")) {
				this.linkAttempts += 1;
				if (this.linkAttempts >= MAX_LINK_ATTEMPTS) {
					// rotateLinkCode() clears linkLockoutUntil (it's also used for a plain
					// manual reset), so the lockout must be set AFTER it runs, not before.
					this.rotateLinkCode();
					this.linkLockoutUntil = now + LINK_LOCKOUT_MS;
					this.onStateChange(this.getStatePatch());
					await this.sendMessage(chatId, "Too many attempts. Link code has been reset — check /phone code for the new code.");
				} else {
					this.onStateChange(this.getStatePatch());
					await this.sendMessage(chatId, "Link code rejected.");
				}
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

	private async deliverResult(chatId: string, result: RemoteTurnResult) {
		if (result.audioPath) {
			try {
				await this.sendAudio(chatId, result.audioPath);
			} finally {
				await rm(result.audioPath, { force: true });
			}
		}
		const busyPrefix = result.busy ? "Pi is busy.\n\n" : "";
		const text = result.transcript
			? `${busyPrefix}Heard: "${result.transcript}"\n\n${result.replyText}`
			: `${busyPrefix}${result.replyText}`;
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
		const response = await withAbortTimeout((signal) =>
			fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, { signal }),
		);
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
		const response = await withAbortTimeout((signal) =>
			fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
				method: "POST",
				body,
				signal,
			}),
		);
		if (!response.ok) {
			throw new Error(`Telegram ${method} failed (${response.status})`);
		}
		return (await response.json()) as T;
	}

	private getStatePatch(patch: Partial<PhoneBridgeState> = {}) {
		return {
			linkCode: this.linkCode,
			linkedChatId: this.linkedChatId,
			lastUpdateId: this.lastUpdateId,
			lastPollAt: this.lastPollAt,
			consecutivePollFailures: this.consecutivePollFailures,
			lastError: this.lastError,
			linkAttempts: this.linkAttempts,
			linkLockoutUntil: this.linkLockoutUntil,
			linkCodeIssuedAt: this.linkCodeIssuedAt,
			...patch,
		};
	}

	private async delay(ms: number) {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}
}

const MAX_LINK_ATTEMPTS = 5;
const LINK_LOCKOUT_MS = 5 * 60 * 1000;
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

function generateLinkCode() {
	// crypto.randomInt is uniform and unpredictable; the old Math.random() code
	// was guessable and the /link handler had no throttling.
	return String(randomInt(100000, 1000000));
}
