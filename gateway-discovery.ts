import { spawn } from "node:child_process";

/**
 * Tailnet gateway roster.
 *
 * Every pi-speak gateway already advertises itself on its tailnet IP via the
 * public `/.well-known/pi-speak` descriptor. What a phone client cannot do is
 * enumerate tailnet peers (the Tailscale mobile apps expose no peer API to
 * third-party apps), so discovery is host-assisted: the client asks any paired
 * gateway `GET /v1/gateways`, and that gateway probes its tailnet peers for
 * other live gateways and returns the roster.
 */

export type TailnetPeer = {
	hostName: string;
	dnsName?: string;
	os?: string;
	online: boolean;
	/** First Tailscale IPv4 address (100.64.0.0/10). */
	ip?: string;
};

export type GatewayDescriptor = {
	schema: string;
	name?: string;
	serverId?: string;
	version?: string;
	authRequired?: boolean;
	/** Base URL that answered the probe, e.g. `http://100.109.244.1:8767`. */
	baseUrl: string;
};

export type DiscoveredGateway = { peer: TailnetPeer; descriptor: GatewayDescriptor };

export type GatewayRoster = {
	gateways: DiscoveredGateway[];
	peersProbed: number;
	errors: string[];
};

export const DISCOVERY_SCHEMA = "pi-speak.discovery.v1";
export const DISCOVERY_PATH = "/.well-known/pi-speak";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parse `tailscale status --json` output into the peer list. Throws on malformed JSON. */
export function parseTailscaleStatus(raw: string): TailnetPeer[] {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || !isRecord(parsed.Peer)) return [];
	const peers: TailnetPeer[] = [];
	for (const entry of Object.values(parsed.Peer)) {
		if (!isRecord(entry) || typeof entry.HostName !== "string" || !entry.HostName) continue;
		const ips = Array.isArray(entry.TailscaleIPs) ? entry.TailscaleIPs : [];
		const ip = ips.find((candidate): candidate is string => typeof candidate === "string" && candidate.includes("."));
		peers.push({
			hostName: entry.HostName,
			...(typeof entry.DNSName === "string" && entry.DNSName ? { dnsName: entry.DNSName.replace(/\.$/, "") } : {}),
			...(typeof entry.OS === "string" && entry.OS ? { os: entry.OS } : {}),
			online: entry.Online === true,
			...(ip ? { ip } : {}),
		});
	}
	return peers;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Probe one base URL for a pi-speak discovery descriptor; undefined when absent/unreachable/foreign. */
export async function probeGatewayDescriptor(
	baseUrl: string,
	opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<GatewayDescriptor | undefined> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
	try {
		const response = await fetchImpl(`${baseUrl}${DISCOVERY_PATH}`, { signal: controller.signal });
		if (!response.ok) return undefined;
		const body = await response.json();
		if (!isRecord(body) || body.schema !== DISCOVERY_SCHEMA) return undefined;
		return {
			schema: DISCOVERY_SCHEMA,
			...(typeof body.name === "string" ? { name: body.name } : {}),
			...(typeof body.serverId === "string" ? { serverId: body.serverId } : {}),
			...(typeof body.version === "string" ? { version: body.version } : {}),
			...(typeof body.authRequired === "boolean" ? { authRequired: body.authRequired } : {}),
			baseUrl,
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

function runTailscaleStatus(timeoutMs: number): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("tailscale", ["status", "--json"], { windowsHide: true });
	const chunks: Buffer[] = [];
	const timer = setTimeout(() => {
		child.kill();
		reject(new Error(`tailscale status timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
	child.on("error", (error) => {
		clearTimeout(timer);
		reject(error);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
		else reject(new Error(`tailscale status exited with code ${code}`));
	});
	return promise;
}

/**
 * Probe online tailnet peers for live pi-speak gateways. Fully injectable for
 * tests; degrades to an empty roster with an error entry when the `tailscale`
 * CLI is unavailable.
 */
export async function discoverTailnetGateways(
	opts: {
		ports?: number[];
		probeTimeoutMs?: number;
		statusTimeoutMs?: number;
		getStatusJson?: (timeoutMs: number) => Promise<string>;
		fetchImpl?: FetchLike;
	} = {},
): Promise<GatewayRoster> {
	const ports = opts.ports?.length ? [...new Set(opts.ports)] : [8767];
	const errors: string[] = [];
	let peers: TailnetPeer[];
	try {
		const raw = await (opts.getStatusJson ?? runTailscaleStatus)(opts.statusTimeoutMs ?? 5000);
		peers = parseTailscaleStatus(raw);
	} catch (error) {
		return { gateways: [], peersProbed: 0, errors: [`tailscale status unavailable: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const candidates = peers.filter((peer) => peer.online && peer.ip);
	const results = await Promise.all(
		candidates.map(async (peer): Promise<DiscoveredGateway | undefined> => {
			for (const port of ports) {
				const descriptor = await probeGatewayDescriptor(`http://${peer.ip}:${port}`, {
					timeoutMs: opts.probeTimeoutMs,
					fetchImpl: opts.fetchImpl,
				});
				if (descriptor) return { peer, descriptor };
			}
			return undefined;
		}),
	);
	return {
		gateways: results.filter((entry): entry is DiscoveredGateway => !!entry),
		peersProbed: candidates.length,
		errors,
	};
}
