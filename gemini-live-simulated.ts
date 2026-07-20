import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

export const SIMULATED_LIVE_MODEL = "simulated-live-1";

export interface SimulatedLiveSession {
	sendRealtimeInput(input: {
		media?: { data?: string; mimeType?: string };
		audio?: { data?: string; mimeType?: string };
		audioStreamEnd?: boolean;
		text?: string;
		activityStart?: object;
		activityEnd?: object;
	}): void;
	sendClientContent(input: {
		turns?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
		turnComplete?: boolean;
	}): void;
	sendToolResponse(input: {
		functionResponses: Array<{ id?: string; name?: string; response?: Record<string, unknown> }> | { id?: string; name?: string; response?: Record<string, unknown> };
	}): void;
	close(): void;
}

export interface SimulatedLiveClient {
	live: {
		connect(params: {
			model: string;
			config?: unknown;
			callbacks: {
				onopen?: (() => void) | null;
				onmessage: (message: unknown) => void;
				onerror?: ((e: unknown) => void) | null;
				onclose?: ((e: unknown) => void) | null;
			};
		}): Promise<SimulatedLiveSession>;
	};
}

interface SimulatedCallbacks {
	onopen?: (() => void) | null;
	onmessage: (message: unknown) => void;
	onerror?: ((e: unknown) => void) | null;
	onclose?: ((e: unknown) => void) | null;
}

interface ScenarioTurn {
	match?: string;
	response: string;
	firstAudioDelayMs?: number;
	chunkMs?: number;
	audio?: boolean;
	toolCall?: { name: string; args?: Record<string, unknown> };
	goAwayAfterMs?: number;
}

interface Scenario {
	name?: string;
	turns: ScenarioTurn[];
	fallback?: ScenarioTurn;
}

interface ReplyGeneration {
	cancelled: boolean;
	streaming: boolean;
	waitingForTool: boolean;
	toolId?: string;
	timers: Set<NodeJS.Timeout>;
	turn: ScenarioTurn;
}

function parseTimescale(env: NodeJS.ProcessEnv): number {
	const value = env.PI_SPEAK_SIM_TIMESCALE;
	if (value === undefined || value === "") return 1;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

function scaledDelay(delayMs: number, timescale: number): number {
	return Math.max(0, Math.round(Math.max(0, delayMs) * timescale));
}

function readOptionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${path} must be a string`);
	return value;
}

function readOptionalNumber(value: unknown, path: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${path} must be a non-negative finite number`);
	}
	return value;
}

function readTurn(value: unknown, path: string): ScenarioTurn {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const source = value as Record<string, unknown>;
	if (typeof source.response !== "string") throw new Error(`${path}.response must be a string`);
	let toolCall: ScenarioTurn["toolCall"];
	if (source.toolCall !== undefined) {
		if (!source.toolCall || typeof source.toolCall !== "object" || Array.isArray(source.toolCall)) {
			throw new Error(`${path}.toolCall must be an object`);
		}
		const toolSource = source.toolCall as Record<string, unknown>;
		if (typeof toolSource.name !== "string" || !toolSource.name) throw new Error(`${path}.toolCall.name must be a non-empty string`);
		if (toolSource.args !== undefined && (!toolSource.args || typeof toolSource.args !== "object" || Array.isArray(toolSource.args))) {
			throw new Error(`${path}.toolCall.args must be an object`);
		}
		toolCall = {
			name: toolSource.name,
			args: toolSource.args as Record<string, unknown> | undefined,
		};
	}
	if (source.audio !== undefined && typeof source.audio !== "boolean") throw new Error(`${path}.audio must be a boolean`);
	return {
		match: readOptionalString(source.match, `${path}.match`),
		response: source.response,
		firstAudioDelayMs: readOptionalNumber(source.firstAudioDelayMs, `${path}.firstAudioDelayMs`),
		chunkMs: readOptionalNumber(source.chunkMs, `${path}.chunkMs`),
		audio: source.audio as boolean | undefined,
		toolCall,
		goAwayAfterMs: readOptionalNumber(source.goAwayAfterMs, `${path}.goAwayAfterMs`),
	};
}

function loadScenario(env: NodeJS.ProcessEnv): Scenario | undefined {
	const scenarioPath = env.PI_SPEAK_SIM_SCENARIO;
	if (!scenarioPath) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(scenarioPath, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to load simulated Live scenario "${scenarioPath}": ${detail}`);
	}
	try {
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("scenario must be an object");
		const source = parsed as Record<string, unknown>;
		const turnsValue = source.turns;
		if (turnsValue !== undefined && !Array.isArray(turnsValue)) throw new Error("scenario.turns must be an array");
		return {
			name: readOptionalString(source.name, "scenario.name"),
			turns: (turnsValue ?? []).map((turn, index) => readTurn(turn, `scenario.turns[${index}]`)),
			fallback: source.fallback === undefined ? undefined : readTurn(source.fallback, "scenario.fallback"),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to load simulated Live scenario "${scenarioPath}": ${detail}`);
	}
}

function transcriptChunks(text: string): string[] {
	const midpoint = Math.max(1, Math.ceil(text.length / 2));
	return [text.slice(0, midpoint), text.slice(midpoint)];
}

function createSpeechAudio(text: string, chunkMs: number): Buffer[] {
	const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
	const durationMs = Math.max(400, 70 * wordCount);
	const sampleRate = 24_000;
	const sampleCount = Math.round(sampleRate * durationMs / 1_000);
	const pcm = Buffer.alloc(sampleCount * 2);
	const amplitude = Math.round(0.25 * 32_767);
	for (let sample = 0; sample < sampleCount; sample += 1) {
		const progress = sampleCount > 1 ? sample / (sampleCount - 1) : 0;
		const frequency = 220 + 220 * progress;
		pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * frequency * sample / sampleRate)), sample * 2);
	}
	const samplesPerChunk = Math.max(1, Math.round(sampleRate * chunkMs / 1_000));
	const bytesPerChunk = samplesPerChunk * 2;
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) chunks.push(pcm.subarray(offset, offset + bytesPerChunk));
	return chunks;
}

class SimulatedSession implements SimulatedLiveSession {
	private readonly allTimers = new Set<NodeJS.Timeout>();
	private readonly consumedTurns = new Set<number>();
	private activeGeneration: ReplyGeneration | undefined;
	private audioSilenceTimer: NodeJS.Timeout | undefined;
	private audioReceived = false;
	private closed = false;
	private closeSent = false;
	private functionCallNumber = 0;

	constructor(
		private readonly callbacks: SimulatedCallbacks,
		private readonly scenario: Scenario | undefined,
		private readonly timescale: number,
	) {}

	open(resolve: (session: SimulatedLiveSession) => void): void {
		this.schedule(0, () => {
			this.callbacks.onopen?.();
			resolve(this);
			this.schedule(0, () => {
				this.emit({ setupComplete: {} });
				this.schedule(0, () => this.emit({ sessionResumptionUpdate: { newHandle: "sim-handle-1", resumable: true } }));
			});
		});
	}

	sendRealtimeInput(input: {
		media?: { data?: string; mimeType?: string };
		audio?: { data?: string; mimeType?: string };
		audioStreamEnd?: boolean;
		text?: string;
		activityStart?: object;
		activityEnd?: object;
	}): void {
		if (this.closed) return;
		if (input.activityStart !== undefined) this.interruptGeneration();
		if (input.media || input.audio) {
			this.audioReceived = true;
			this.resetAudioSilenceTimer();
		}
		if (input.activityEnd !== undefined || input.audioStreamEnd) this.completeAudioTurn();
	}

	sendClientContent(input: {
		turns?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
		turnComplete?: boolean;
	}): void {
		if (this.closed || !input.turnComplete) return;
		const text = (input.turns ?? [])
			.flatMap((turn) => turn.parts ?? [])
			.map((part) => part.text ?? "")
			.join("");
		this.beginGeneration(this.selectTurn(text, false));
	}

	sendToolResponse(input: {
		functionResponses: Array<{ id?: string; name?: string; response?: Record<string, unknown> }> | { id?: string; name?: string; response?: Record<string, unknown> };
	}): void {
		if (this.closed) return;
		const generation = this.activeGeneration;
		if (!generation?.waitingForTool || !generation.toolId) return;
		const responses = Array.isArray(input.functionResponses) ? input.functionResponses : [input.functionResponses];
		if (!responses.some((response) => response.id === generation.toolId)) return;
		generation.waitingForTool = false;
		this.startReply(generation);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.allTimers) clearTimeout(timer);
		this.allTimers.clear();
		this.activeGeneration?.timers.clear();
		this.activeGeneration = undefined;
		this.audioSilenceTimer = undefined;
		if (!this.closeSent) {
			this.closeSent = true;
			this.callbacks.onclose?.({ code: 1000, reason: "simulated session closed" });
		}
	}

	private selectTurn(text: string, audio: boolean): ScenarioTurn {
		const normalizedText = text.toLowerCase();
		if (this.scenario) {
			for (let index = 0; index < this.scenario.turns.length; index += 1) {
				const turn = this.scenario.turns[index];
				if (this.consumedTurns.has(index)) continue;
				if (!turn.match || normalizedText.includes(turn.match.toLowerCase())) {
					this.consumedTurns.add(index);
					return turn;
				}
			}
			if (this.scenario.fallback) return this.scenario.fallback;
		}
		return { response: audio ? "I heard your audio message." : `You said: ${text}` };
	}

	private resetAudioSilenceTimer(): void {
		if (this.audioSilenceTimer) this.cancelTimer(this.audioSilenceTimer);
		this.audioSilenceTimer = this.schedule(800, () => {
			this.audioSilenceTimer = undefined;
			this.completeAudioTurn();
		});
	}

	private completeAudioTurn(): void {
		if (this.closed || !this.audioReceived) return;
		if (this.audioSilenceTimer) this.cancelTimer(this.audioSilenceTimer);
		this.audioSilenceTimer = undefined;
		this.audioReceived = false;
		this.beginGeneration(this.selectTurn("", true));
	}

	private beginGeneration(turn: ScenarioTurn): void {
		const generation: ReplyGeneration = {
			cancelled: false,
			streaming: true,
			waitingForTool: false,
			timers: new Set(),
			turn,
		};
		this.activeGeneration = generation;
		if (turn.toolCall) {
			generation.waitingForTool = true;
			generation.toolId = `sim-fc-${this.functionCallNumber += 1}`;
			this.emit({ toolCall: { functionCalls: [{ id: generation.toolId, name: turn.toolCall.name, args: turn.toolCall.args ?? {} }] } });
			return;
		}
		this.startReply(generation);
	}

	private startReply(generation: ReplyGeneration): void {
		if (generation.cancelled || this.activeGeneration !== generation) return;
		this.scheduleForGeneration(generation, generation.turn.firstAudioDelayMs ?? 300, () => this.emitTranscript(generation, 0));
	}

	private emitTranscript(generation: ReplyGeneration, index: number): void {
		if (!this.isCurrentGeneration(generation)) return;
		const chunks = transcriptChunks(generation.turn.response);
		this.emit({ serverContent: { outputTranscription: { text: chunks[index] } } });
		if (!this.isCurrentGeneration(generation)) return;
		if (index + 1 < chunks.length) {
			this.scheduleForGeneration(generation, 0, () => this.emitTranscript(generation, index + 1));
			return;
		}
		this.scheduleForGeneration(generation, 0, () => {
			this.emit({ serverContent: { outputTranscription: { finished: true } } });
			this.emitAudio(generation, 0, this.audioChunksFor(generation.turn));
		});
	}

	private audioChunksFor(turn: ScenarioTurn): Buffer[] {
		if (turn.audio === false) return [];
		const requestedChunkMs = turn.chunkMs ?? 20;
		const chunkMs = Math.min(40, Math.max(20, Math.round(requestedChunkMs)));
		return createSpeechAudio(turn.response, chunkMs);
	}

	private emitAudio(generation: ReplyGeneration, index: number, chunks: Buffer[]): void {
		if (!this.isCurrentGeneration(generation)) return;
		if (index >= chunks.length) {
			this.finishGeneration(generation);
			return;
		}
		this.emit({
			serverContent: {
				modelTurn: {
					parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: chunks[index].toString("base64") } }],
				},
			},
		});
		if (!this.isCurrentGeneration(generation)) return;
		const requestedChunkMs = generation.turn.chunkMs ?? 20;
		const chunkMs = Math.min(40, Math.max(20, Math.round(requestedChunkMs)));
		this.scheduleForGeneration(generation, chunkMs, () => this.emitAudio(generation, index + 1, chunks));
	}

	private finishGeneration(generation: ReplyGeneration): void {
		if (!this.isCurrentGeneration(generation)) return;
		this.emit({ serverContent: { generationComplete: true } });
		this.emit({ serverContent: { turnComplete: true } });
		this.activeGeneration = undefined;
		if (generation.turn.goAwayAfterMs !== undefined) {
			this.schedule(generation.turn.goAwayAfterMs, () => this.emit({ goAway: { timeLeft: "5s" } }));
		}
	}

	private interruptGeneration(): void {
		const generation = this.activeGeneration;
		if (!generation || generation.waitingForTool || generation.cancelled) return;
		generation.cancelled = true;
		for (const timer of generation.timers) this.cancelTimer(timer);
		generation.timers.clear();
		this.activeGeneration = undefined;
		this.emit({ serverContent: { interrupted: true } });
		this.emit({ serverContent: { turnComplete: true } });
	}

	private isCurrentGeneration(generation: ReplyGeneration): boolean {
		return !this.closed && !generation.cancelled && this.activeGeneration === generation;
	}

	private schedule(delayMs: number, callback: () => void, generation?: ReplyGeneration): NodeJS.Timeout {
		let timer: NodeJS.Timeout;
		timer = setTimeout(() => {
			this.allTimers.delete(timer);
			generation?.timers.delete(timer);
			if (!this.closed && !generation?.cancelled) callback();
		}, scaledDelay(delayMs, this.timescale));
		this.allTimers.add(timer);
		generation?.timers.add(timer);
		return timer;
	}

	private scheduleForGeneration(generation: ReplyGeneration, delayMs: number, callback: () => void): void {
		this.schedule(delayMs, callback, generation);
	}

	private cancelTimer(timer: NodeJS.Timeout): void {
		clearTimeout(timer);
		this.allTimers.delete(timer);
		this.activeGeneration?.timers.delete(timer);
	}

	private emit(message: unknown): void {
		if (!this.closed) this.callbacks.onmessage(message);
	}
}

function validateConnectParameters(params: {
	model: string;
	config?: unknown;
	callbacks: SimulatedCallbacks;
}): void {
	if (!params || typeof params.model !== "string" || !params.model.trim()) throw new Error("Simulated Live connect requires a non-empty model");
	if (!params.callbacks || typeof params.callbacks !== "object" || typeof params.callbacks.onmessage !== "function") {
		throw new Error("Simulated Live connect requires callbacks.onmessage");
	}
	for (const callbackName of ["onopen", "onerror", "onclose"] as const) {
		const callback = params.callbacks[callbackName];
		if (callback !== undefined && callback !== null && typeof callback !== "function") {
			throw new Error(`Simulated Live connect requires callbacks.${callbackName} to be a function when provided`);
		}
	}
}

export function createSimulatedLiveClient(env: NodeJS.ProcessEnv = process.env): SimulatedLiveClient {
	return {
		live: {
			connect(params) {
				validateConnectParameters(params);
				let scenario: Scenario | undefined;
				try {
					scenario = loadScenario(env);
				} catch (error) {
					params.callbacks.onerror?.(error);
					throw error;
				}
				const session = new SimulatedSession(params.callbacks, scenario, parseTimescale(env));
				return new Promise<SimulatedLiveSession>((resolve) => session.open(resolve));
			},
		},
	};
}
