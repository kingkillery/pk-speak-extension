#!/usr/bin/env bun
/**
 * Self-contained omp collab relay -- a content-blind WebSocket switch for `/collab`.
 *
 * Derived from oh-my-pi-fork packages/collab-web/scripts/local-relay.ts with the
 * envelope codec inlined, so it has ZERO monorepo dependencies and deploys as one
 * file. Runs under Bun. Intended to run on an always-on box (e.g. a Mac mini on the
 * tailnet) and be exposed as wss:// via `tailscale serve` (TLS) so omp's
 * collab.relayUrl can point at it instead of the public wss://my.omp.sh.
 *
 * Relay contract (must match relay-client.ts exactly):
 *  - GET /r/<roomId>?role=host|guest          -> WebSocket upgrade
 *  - host creates the room; a 2nd host -> close 4009; a guest w/o room -> close 4004
 *  - host binary frame: envelope peerId 0 broadcasts to every guest; peerId N -> that guest only
 *  - guest binary frame: rewrite the first 4 envelope bytes to the sender's peerId, forward to host
 *  - TEXT control to host: {"t":"peer-joined","peer":N} / {"t":"peer-left","peer":N}
 *  - host disconnect: {"t":"room-closed"} to every guest, then close 4001; room is GC'd
 *
 * The relay never sees plaintext: payloads stay AES-GCM sealed end to end; only the
 * 4-byte cleartext peerId header is ever read/rewritten.
 *
 * Binds to 127.0.0.1 by default (override with RELAY_HOST) so it is reachable only
 * through the local `tailscale serve` proxy, never directly on the network.
 *
 * Usage:  bun collab-relay.ts [--port 7466]
 */

const ENVELOPE_HEADER_LENGTH = 4;
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const DEFAULT_PORT = 7466;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	peerId: number; // assigned on open for guests; the host stays 0
}
type RelaySocket = Bun.ServerWebSocket<SocketData>;
interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

// --- inlined envelope codec (oh-my-pi-fork collab-web/src/lib/link.ts) ---
function unpackEnvelopePeer(data: Uint8Array): number | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	return new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
}
function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

function parsePort(argv: readonly string[]): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") raw = argv[i + 1];
		else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
	}
	if (raw === undefined) return Number(process.env.RELAY_PORT) || DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		console.error(`collab-relay: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

const rooms = new Map<string, Room>();
const host = process.env.RELAY_HOST || "127.0.0.1";
const port = parsePort(Bun.argv.slice(2));

const server = Bun.serve<SocketData>({
	hostname: host,
	port,
	fetch(req, srv): Response | undefined {
		const url = new URL(req.url);
		if (url.pathname === "/healthz") return new Response("ok");
		const match = ROOM_PATH_RE.exec(url.pathname);
		const role = url.searchParams.get("role");
		if (!match || (role !== "host" && role !== "guest")) {
			return new Response("not found", { status: 404 });
		}
		const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
		if (srv.upgrade(req, { data })) return undefined;
		return new Response("websocket upgrade required", { status: 426 });
	},
	websocket: {
		idleTimeout: 240, // Bun auto-sends pings; drop half-open sockets after ~4 min idle
		open(ws: RelaySocket): void {
			const { roomId, role } = ws.data;
			if (role === "host") {
				if (rooms.has(roomId)) {
					ws.close(4009, "a host is already connected for this room");
					return;
				}
				rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
				return;
			}
			const room = rooms.get(roomId);
			if (!room) {
				ws.close(4004, "no such room");
				return;
			}
			const peerId = room.nextPeerId++;
			ws.data.peerId = peerId;
			room.guests.set(peerId, ws);
			room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
		},
		message(ws: RelaySocket, message: string | Buffer): void {
			if (typeof message === "string") return; // clients never send TEXT
			const room = rooms.get(ws.data.roomId);
			if (!room) return;
			if (ws.data.role === "host") {
				const peerId = unpackEnvelopePeer(message);
				if (peerId === null) return;
				if (peerId === 0) {
					for (const guest of room.guests.values()) guest.send(message);
				} else {
					room.guests.get(peerId)?.send(message);
				}
				return;
			}
			if (message.byteLength < ENVELOPE_HEADER_LENGTH) return;
			rewriteEnvelopePeer(message, ws.data.peerId);
			room.host.send(message);
		},
		close(ws: RelaySocket): void {
			const { roomId, role, peerId } = ws.data;
			const room = rooms.get(roomId);
			if (!room) return;
			if (role === "host") {
				if (room.host !== ws) return; // rejected 2nd host: not ours to tear down
				rooms.delete(roomId);
				const closure = JSON.stringify({ t: "room-closed" });
				for (const guest of room.guests.values()) {
					guest.send(closure);
					guest.close(4001, "room closed");
				}
				room.guests.clear();
				return;
			}
			if (room.guests.delete(peerId)) {
				room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
			}
		},
	},
});

console.log(`collab relay listening on ws://${host}:${server.port} (rooms via /r/<roomId>?role=host|guest)`);

function shutdown(): void {
	for (const room of rooms.values()) {
		const closure = JSON.stringify({ t: "room-closed" });
		for (const guest of room.guests.values()) {
			guest.send(closure);
			guest.close(4001, "room closed");
		}
		room.host.close(1001, "relay shutting down");
	}
	rooms.clear();
	server.stop(true);
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
