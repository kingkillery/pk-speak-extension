#!/usr/bin/env node
/**
 * Text-only synthetic conversation smoke client for ws://host:port/v1/live.
 * Sends `{ type: "text", text }` turns and waits for any server text JSON reply.
 */
import { WebSocket } from "ws";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8767;
const DEFAULT_TURNS = 1;
const DEFAULT_TEXT = "list sessions";
const DEFAULT_INTERVAL_SEC = 1;
const DEFAULT_TIMEOUT_SEC = 10;

type CliOptions = {
	host: string;
	port: number;
	token?: string;
	turns: number;
	text: string;
	intervalSec: number;
	timeoutSec: number;
	dryRun: boolean;
	help: boolean;
};

type ServerTextMessage = {
	type?: string;
	serverSequenceId?: number;
	message?: string;
	[key: string]: unknown;
};

type TurnResult = {
	turn: number;
	ok: boolean;
	timedOut: boolean;
	error?: string;
	messageTypes: Record<string, number>;
	textMessages: number;
	nonErrorTextMessages: number;
};

type WsRawData = string | Buffer | ArrayBuffer | Buffer[];

type WsClient = {
	readonly readyState: number;
	send(data: string, cb?: (err?: Error) => void): void;
	close(code?: number, data?: string): void;
	on(event: "open", listener: () => void): void;
	on(event: "message", listener: (data: WsRawData, isBinary: boolean) => void): void;
	on(event: "close", listener: (code: number, reason: Buffer) => void): void;
	on(event: "error", listener: (err: Error) => void): void;
	removeListener(event: string, listener: (...args: never[]) => void): void;
};

type WsClientConstructor = {
	new (address: string, options?: { headers?: Record<string, string> }): WsClient;
	readonly OPEN: number;
};

const WebSocketClient = WebSocket as unknown as WsClientConstructor;

function printHelp(): void {
	console.log(
		[
			"Usage: node dist/scripts/synthetic-live-smoke.js [options]",
			"",
			"Synthetic text-only smoke client for the pk-speak /v1/live WebSocket.",
			"",
			"Options:",
			`  --host <host>       Gateway host (default: ${DEFAULT_HOST})`,
			`  --port <port>       Gateway port (default: ${DEFAULT_PORT})`,
			"  --token <token>     Optional bearer / x-pi-speak-token value",
			`  --turns <n>         Number of text turns to send (default: ${DEFAULT_TURNS})`,
			`  --text <prompt>     Text prompt per turn (default: ${JSON.stringify(DEFAULT_TEXT)})`,
			`  --interval <sec>    Seconds between turns (default: ${DEFAULT_INTERVAL_SEC})`,
			`  --timeout <sec>     Per-turn response timeout (default: ${DEFAULT_TIMEOUT_SEC})`,
			"  --dry-run           Print the resolved plan without opening a socket",
			"  -h, --help          Show this help",
			"",
			"Examples:",
			"  node dist/scripts/synthetic-live-smoke.js --help",
			"  node dist/scripts/synthetic-live-smoke.js --dry-run",
			"  node dist/scripts/synthetic-live-smoke.js --turns 1 --text \"list sessions\" --timeout 5",
		].join("\n"),
	);
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		host: DEFAULT_HOST,
		port: DEFAULT_PORT,
		turns: DEFAULT_TURNS,
		text: DEFAULT_TEXT,
		intervalSec: DEFAULT_INTERVAL_SEC,
		timeoutSec: DEFAULT_TIMEOUT_SEC,
		dryRun: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			throw new Error(`Missing value for --${key}`);
		}
		i += 1;
		switch (key) {
			case "host":
				options.host = next;
				break;
			case "port":
				options.port = parsePositiveInt(next, "port");
				break;
			case "token":
				options.token = next;
				break;
			case "turns":
				options.turns = parseNonNegativeInt(next, "turns");
				break;
			case "text":
				options.text = next;
				break;
			case "interval":
				options.intervalSec = parseNonNegativeNumber(next, "interval");
				break;
			case "timeout":
				options.timeoutSec = parsePositiveNumber(next, "timeout");
				break;
			default:
				throw new Error(`Unknown option: --${key}`);
		}
	}

	return options;
}

function parsePositiveInt(raw: string, name: string): number {
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid --${name}: ${raw}`);
	}
	return value;
}

function parseNonNegativeInt(raw: string, name: string): number {
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid --${name}: ${raw}`);
	}
	return value;
}

function parsePositiveNumber(raw: string, name: string): number {
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid --${name}: ${raw}`);
	}
	return value;
}

function parseNonNegativeNumber(raw: string, name: string): number {
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid --${name}: ${raw}`);
	}
	return value;
}

function maskToken(token: string | undefined): string {
	if (!token) return "(none)";
	if (token.length <= 8) return "***";
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function resolveLiveUrl(host: string, port: number): string {
	const raw = host.trim();
	const secure = /^(https|wss)/i.test(raw);
	const scheme = secure ? "wss" : "ws";
	let hostname = raw.replace(/^(wss|ws|https|http):\/\//i, "");
	hostname = hostname.replace(/\/.*$/, "");
	if (!hostname.includes(":")) {
		hostname = `${hostname}:${port}`;
	}
	return `${scheme}://${hostname}/v1/live`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function rawToString(data: WsRawData): string {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return Buffer.from(data).toString("utf8");
}

function printDryRun(options: CliOptions, url: string): void {
	const plannedTurns = Array.from({ length: options.turns }, (_, index) => ({
		turn: index + 1,
		text: options.text,
	}));
	console.log(
		[
			"synthetic-live-smoke dry-run",
			`url: ${url}`,
			`host: ${options.host}`,
			`port: ${options.port}`,
			`token: ${maskToken(options.token)}`,
			`turns: ${options.turns}`,
			`intervalSec: ${options.intervalSec}`,
			`timeoutSec: ${options.timeoutSec}`,
			`text: ${JSON.stringify(options.text)}`,
			`plannedTurns: ${JSON.stringify(plannedTurns)}`,
			"network: skipped",
		].join("\n"),
	);
}

type LiveSession = {
	ws: WsClient;
	messageTypes: Record<string, number>;
	textMessages: number;
	nonErrorTextMessages: number;
	closed: boolean;
	closeError?: string;
	waiters: Array<() => void>;
};

function notifyWaiters(session: LiveSession): void {
	const waiters = session.waiters.splice(0, session.waiters.length);
	for (const wake of waiters) wake();
}

function attachSessionHandlers(session: LiveSession): void {
	const { ws } = session;
	ws.on("message", (data: WsRawData, isBinary: boolean) => {
		if (isBinary) {
			bump(session.messageTypes, "binary");
			return;
		}
		session.textMessages += 1;
		const raw = rawToString(data);
		let parsed: ServerTextMessage | undefined;
		try {
			parsed = JSON.parse(raw) as ServerTextMessage;
		} catch {
			bump(session.messageTypes, "non_json_text");
			session.nonErrorTextMessages += 1;
			notifyWaiters(session);
			return;
		}
		const type = typeof parsed.type === "string" && parsed.type ? parsed.type : "unknown";
		bump(session.messageTypes, type);
		if (type === "error") {
			session.closeError = typeof parsed.message === "string" ? parsed.message : "server error";
			notifyWaiters(session);
			return;
		}
		session.nonErrorTextMessages += 1;
		notifyWaiters(session);
	});
	ws.on("close", (code: number, reason: Buffer) => {
		session.closed = true;
		const detail = reason.toString("utf8") || session.closeError || "(no reason)";
		session.closeError = `WebSocket closed (${code}): ${detail}`;
		notifyWaiters(session);
	});
	ws.on("error", (err: Error) => {
		session.closed = true;
		session.closeError = err.message;
		notifyWaiters(session);
	});
}

async function openSession(url: string, token: string | undefined): Promise<LiveSession> {
	const headers: Record<string, string> = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
		headers["x-pi-speak-token"] = token;
	}

	const ws = await new Promise<WsClient>((resolve, reject) => {
		const socket = new WebSocketClient(url, Object.keys(headers).length > 0 ? { headers } : undefined);
		let settled = false;

		function cleanup(): void {
			socket.removeListener("open", onOpen as (...args: never[]) => void);
			socket.removeListener("error", onError as (...args: never[]) => void);
			socket.removeListener("close", onClose as (...args: never[]) => void);
		}

		function onOpen(): void {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		}

		function onError(err: Error): void {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				socket.close();
			} catch {
				// ignore
			}
			reject(err);
		}

		function onClose(code: number, reason: Buffer): void {
			if (settled) return;
			settled = true;
			cleanup();
			const detail = reason.toString("utf8") || "(no reason)";
			reject(new Error(`WebSocket closed before open (${code}): ${detail}`));
		}

		socket.on("open", onOpen);
		socket.on("error", onError);
		socket.on("close", onClose);
	});

	const session: LiveSession = {
		ws,
		messageTypes: {},
		textMessages: 0,
		nonErrorTextMessages: 0,
		closed: ws.readyState !== WebSocketClient.OPEN,
		waiters: [],
	};
	attachSessionHandlers(session);
	// Allow an immediate server close (e.g. realtime gateway inactive) to settle.
	await sleep(25);
	return session;
}

async function waitForTurnProgress(session: LiveSession, baselineNonError: number, timeoutSec: number): Promise<TurnResult> {
	const startedAt = Date.now();
	const timeoutMs = Math.max(1, Math.floor(timeoutSec * 1000));

	while (true) {
		if (session.nonErrorTextMessages > baselineNonError) {
			return {
				turn: 0,
				ok: true,
				timedOut: false,
				messageTypes: { ...session.messageTypes },
				textMessages: session.textMessages,
				nonErrorTextMessages: session.nonErrorTextMessages,
			};
		}
		if (session.closed) {
			return {
				turn: 0,
				ok: false,
				timedOut: false,
				error: session.closeError || "WebSocket closed",
				messageTypes: { ...session.messageTypes },
				textMessages: session.textMessages,
				nonErrorTextMessages: session.nonErrorTextMessages,
			};
		}
		const remaining = timeoutMs - (Date.now() - startedAt);
		if (remaining <= 0) {
			return {
				turn: 0,
				ok: false,
				timedOut: true,
				error: `Timed out after ${timeoutSec}s waiting for a text response`,
				messageTypes: { ...session.messageTypes },
				textMessages: session.textMessages,
				nonErrorTextMessages: session.nonErrorTextMessages,
			};
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				const index = session.waiters.indexOf(wake);
				if (index >= 0) session.waiters.splice(index, 1);
				resolve();
			}, remaining);
			function wake(): void {
				clearTimeout(timer);
				resolve();
			}
			session.waiters.push(wake);
		});
	}
}

async function runLive(options: CliOptions, url: string): Promise<number> {
	console.log(`connecting: ${url}`);
	let session: LiveSession;
	try {
		session = await openSession(url, options.token);
	} catch (err) {
		console.error(`connection error: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	if (session.closed) {
		console.error(`connection error: ${session.closeError || "WebSocket closed immediately after open"}`);
		return 1;
	}
	console.log("connected");

	const results: TurnResult[] = [];
	try {
		for (let turn = 1; turn <= options.turns; turn += 1) {
			if (session.closed) {
				results.push({
					turn,
					ok: false,
					timedOut: false,
					error: session.closeError || "WebSocket closed",
					messageTypes: { ...session.messageTypes },
					textMessages: session.textMessages,
					nonErrorTextMessages: session.nonErrorTextMessages,
				});
				break;
			}
			const baseline = session.nonErrorTextMessages;
			console.log(`turn ${turn}/${options.turns}: sending text ${JSON.stringify(options.text)}`);
			const payload = JSON.stringify({ type: "text", text: options.text });
			try {
				await new Promise<void>((resolve, reject) => {
					session.ws.send(payload, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});
			} catch (err) {
				results.push({
					turn,
					ok: false,
					timedOut: false,
					error: err instanceof Error ? err.message : String(err),
					messageTypes: { ...session.messageTypes },
					textMessages: session.textMessages,
					nonErrorTextMessages: session.nonErrorTextMessages,
				});
				break;
			}

			const result = await waitForTurnProgress(session, baseline, options.timeoutSec);
			result.turn = turn;
			results.push(result);
			console.log(
				`turn ${turn}: ok=${result.ok} timedOut=${result.timedOut} textMessages=${result.textMessages} types=${JSON.stringify(result.messageTypes)}${result.error ? ` error=${result.error}` : ""}`,
			);
			if (turn < options.turns && options.intervalSec > 0) {
				await sleep(Math.floor(options.intervalSec * 1000));
			}
		}
	} finally {
		try {
			if (session.ws.readyState === WebSocketClient.OPEN) {
				session.ws.close(1000, "smoke complete");
			}
		} catch {
			// ignore
		}
	}

	const nonErrorCount = session.nonErrorTextMessages;
	const allTimedOut = results.length > 0 && results.every((item) => item.timedOut);

	if (nonErrorCount > 0) {
		console.log(`smoke ok: received ${nonErrorCount} non-error text message(s)`);
		return 0;
	}
	if (allTimedOut) {
		console.error("smoke failed: all turns timed out waiting for a text response");
		return 1;
	}
	console.error("smoke failed: server closed or returned an error before a usable text response");
	return 1;
}

async function main(): Promise<void> {
	let options: CliOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
		return;
	}

	if (options.help) {
		printHelp();
		return;
	}

	if (options.turns === 0) {
		console.error("Invalid --turns: must be >= 1 (got 0)");
		process.exitCode = 1;
		return;
	}

	const url = resolveLiveUrl(options.host, options.port);

	if (options.dryRun) {
		printDryRun(options, url);
		return;
	}

	const code = await runLive(options, url);
	if (code !== 0) {
		process.exitCode = code;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : String(err));
	process.exitCode = 1;
});
