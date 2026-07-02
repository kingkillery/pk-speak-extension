import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared pairing primitives for every desktop-side entrypoint (control server,
 * tray, `pi-speak-server` app, QR scripts): the persistent install auth token
 * and phone-facing base-URL discovery.
 *
 * The install token is the contract that makes pairing survive restarts — the
 * gateway, tray, and server app must all resolve the SAME token or a restart
 * silently unpairs every phone.
 */

export function getInstallAuthTokenPath(): string {
	const base = process.env.PI_SPEAK_CONFIG_DIR
		|| (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "pi-speak"))
		|| (process.env.APPDATA && join(process.env.APPDATA, "pi-speak"))
		|| join(process.cwd(), ".pi-speak");
	return join(base, "http-token");
}

export function getOrCreateInstallAuthToken(): string {
	const tokenFile = getInstallAuthTokenPath();
	try {
		const existing = readFileSync(tokenFile, "utf8").trim();
		if (existing.length >= 24) return existing;
	} catch {
		// Generate below.
	}
	const token = randomBytes(32).toString("base64url");
	try {
		mkdirSync(dirname(tokenFile), { recursive: true });
		writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Keep the server usable even when the config directory is read-only.
	}
	return token;
}

export function isPrivateLanIpv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isTailscaleIpv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * All phone-reachable base URLs for this machine, Tailscale addresses first
 * (they work from anywhere on the tailnet, LAN only works on the same Wi-Fi).
 */
export function getReachableBaseUrls(port: number): string[] {
	const tailscale: string[] = [];
	const lan: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries || []) {
			if (entry.family !== "IPv4" || entry.internal) continue;
			if (isTailscaleIpv4(entry.address)) tailscale.push(`http://${entry.address}:${port}/`);
			else if (isPrivateLanIpv4(entry.address)) lan.push(`http://${entry.address}:${port}/`);
		}
	}
	return [...new Set([...tailscale, ...lan])];
}

/**
 * Best phone-facing base URL: explicit override -> Tailscale -> LAN -> loopback.
 */
export function pickPhoneFacingBaseUrl(port: number): string {
	const override = process.env.PI_SPEAK_PUBLIC_BASE_URL?.trim();
	if (override) return override.endsWith("/") ? override : `${override}/`;
	const [best] = getReachableBaseUrls(port);
	return best || `http://127.0.0.1:${port}/`;
}
