import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

export function getPiSpeakConfigDir(): string {
	return process.env.PI_SPEAK_CONFIG_DIR
		|| (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "pi-speak"))
		|| (process.env.APPDATA && join(process.env.APPDATA, "pi-speak"))
		|| join(process.cwd(), ".pi-speak");
}

export function getInstallAuthTokenPath(): string {
	return join(getPiSpeakConfigDir(), "http-token");
}

/** Root kill-switch path shared across agents (`voice-disabled` under the config dir). */
export function getRootVoiceDisablePath(): string {
	return join(getPiSpeakConfigDir(), "voice-disabled");
}

/** omp built-in vocalizer hard-stop sentinel (`~/.omp/agent/speech-disabled`). */
export function getOmpSpeechDisablePath(): string | undefined {
	const home = process.env.USERPROFILE || process.env.HOME;
	if (!home) return undefined;
	return join(home, ".omp", "agent", "speech-disabled");
}

/** True when either hard-stop sentinel exists (pi-speak or omp). */
export function isRootVoiceDisabled(): boolean {
	if (existsSync(getRootVoiceDisablePath())) return true;
	const omp = getOmpSpeechDisablePath();
	return !!omp && existsSync(omp);
}

export function enableRootVoiceDisable(): void {
	const path = getRootVoiceDisablePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "hard-stop\n", { encoding: "utf8" });
	const omp = getOmpSpeechDisablePath();
	if (omp) {
		mkdirSync(dirname(omp), { recursive: true });
		writeFileSync(omp, "hard-stop\n", { encoding: "utf8" });
	}
}

export function clearRootVoiceDisable(): void {
	for (const candidate of [getRootVoiceDisablePath(), getOmpSpeechDisablePath()]) {
		if (!candidate) continue;
		try {
			unlinkSync(candidate);
		} catch {
			// absent is fine
		}
	}
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
