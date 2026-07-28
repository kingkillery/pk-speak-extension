import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { isTailscaleIpv4 } from "./pairing.js";

const DEFAULT_WHOIS_TIMEOUT_MS = 3_000;
const DEFAULT_POSITIVE_TTL_MS = 30_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;
const MAX_WHOIS_OUTPUT_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

export type TailscaleWhoisLookup = (target: string, timeoutMs: number) => Promise<string>;
export type TailscalePeerVerifier = (remoteAddress: string, remotePort?: number) => Promise<boolean>;

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeTailnetPeerAddress(address: string): string {
	let value = address.trim();
	if (value.startsWith("[") && value.includes("]")) {
		value = value.slice(1, value.indexOf("]"));
	}
	if (value.toLowerCase().startsWith("::ffff:")) {
		const ipv4 = value.slice("::ffff:".length);
		if (isIP(ipv4) === 4) return ipv4;
	}
	const zoneIndex = value.indexOf("%");
	if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
	const family = isIP(value);
	if (family === 4) return value;
	if (family !== 6) return "";
	try {
		return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
	} catch {
		return "";
	}
}

export function isTailscalePeerAddress(address: string): boolean {
	const normalized = normalizeTailnetPeerAddress(address);
	return isTailscaleIpv4(normalized) || normalized.startsWith("fd7a:115c:a1e0:");
}

function addressWithoutPrefix(value: unknown): string {
	if (typeof value !== "string") return "";
	return normalizeTailnetPeerAddress(value.split("/", 1)[0]);
}

function isFunnelIngress(node: JsonRecord): boolean {
	if (node.ShareeNode === true) return true;
	const tags = Array.isArray(node.Tags) ? node.Tags : [];
	if (tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "tag:ingress")) return true;
	const hostinfo = isRecord(node.Hostinfo) ? node.Hostinfo : undefined;
	const names = [node.Name, node.ComputedName, node.ComputedNameWithHost, hostinfo?.Hostname];
	return names.some((name) => typeof name === "string" && name.toLowerCase().startsWith("funnel-ingress-node"));
}

export function isVerifiedTailscaleWhois(raw: string, expectedAddress: string): boolean {
	const expected = normalizeTailnetPeerAddress(expectedAddress);
	if (!isTailscalePeerAddress(expected)) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}
	if (!isRecord(parsed) || !isRecord(parsed.Node)) return false;
	const node = parsed.Node;
	if (isFunnelIngress(node)) return false;
	const hasIdentity = (typeof node.StableID === "string" && node.StableID.length > 0)
		|| (typeof node.ID === "number" && Number.isFinite(node.ID));
	if (!hasIdentity || !Array.isArray(node.Addresses)) return false;
	return node.Addresses.some((address) => addressWithoutPrefix(address) === expected);
}

function formatWhoisTarget(address: string, remotePort?: number): string {
	if (!remotePort || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) return address;
	return isIP(address) === 6 ? `[${address}]:${remotePort}` : `${address}:${remotePort}`;
}

function runTailscaleWhois(target: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const command = process.env.PI_SPEAK_TAILSCALE_CLI?.trim() || "tailscale";
		const child = spawn(command, ["whois", "--json", target], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		const finish = (error?: Error, output?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(output || "");
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error(`tailscale whois timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_WHOIS_OUTPUT_BYTES) {
				child.kill();
				finish(new Error("tailscale whois output exceeded the limit"));
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		child.once("error", (error) => finish(error));
		child.once("close", (code) => {
			if (code === 0) finish(undefined, Buffer.concat(chunks).toString("utf8"));
			else finish(new Error(`tailscale whois exited with code ${code ?? "unknown"}`));
		});
	});
}

export function createTailscalePeerVerifier(
	options: {
		lookup?: TailscaleWhoisLookup;
		timeoutMs?: number;
		positiveTtlMs?: number;
		negativeTtlMs?: number;
		now?: () => number;
	} = {},
): TailscalePeerVerifier {
	const lookup = options.lookup ?? runTailscaleWhois;
	const timeoutMs = options.timeoutMs ?? DEFAULT_WHOIS_TIMEOUT_MS;
	const positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
	const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
	const now = options.now ?? Date.now;
	const cache = new Map<string, { expiresAt: number; trusted: boolean }>();
	const pending = new Map<string, Promise<boolean>>();

	return async (remoteAddress, remotePort) => {
		const address = normalizeTailnetPeerAddress(remoteAddress);
		if (!isTailscalePeerAddress(address)) return false;
		const cached = cache.get(address);
		if (cached && cached.expiresAt > now()) return cached.trusted;
		const existing = pending.get(address);
		if (existing) return existing;

		const verification = (async () => {
			try {
				const raw = await lookup(formatWhoisTarget(address, remotePort), timeoutMs);
				return isVerifiedTailscaleWhois(raw, address);
			} catch {
				return false;
			}
		})().then((trusted) => {
			cache.set(address, {
				expiresAt: now() + (trusted ? positiveTtlMs : negativeTtlMs),
				trusted,
			});
			return trusted;
		}).finally(() => {
			pending.delete(address);
		});
		pending.set(address, verification);
		return verification;
	};
}

export const verifyTailscalePeer = createTailscalePeerVerifier();
