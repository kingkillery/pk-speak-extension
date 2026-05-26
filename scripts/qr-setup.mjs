#!/usr/bin/env node
import { networkInterfaces, platform } from "node:os";
import QRCode from "qrcode";

const PORT = Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10);
const TOKEN = process.env.PI_SPEAK_HTTP_TOKEN || "P-K-Haxx1!";
const TAILSCALE_APPSERVER_IP = "100.76.136.91";
const TAILSCALE_MAC_IP = "100.76.176.119";

function isPrivateLanIpv4(address) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailscaleIpv4(address) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
	return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function getReachableIpv4Addresses() {
	const tailscale = [];
	const lan = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries || []) {
			if (entry.family !== "IPv4" || entry.internal) continue;
			if (isTailscaleIpv4(entry.address)) {
				tailscale.push(entry.address);
			} else if (isPrivateLanIpv4(entry.address)) {
				lan.push(entry.address);
			}
		}
	}
	return { tailscale: [...new Set(tailscale)], lan: [...new Set(lan)] };
}

function getDefaultTailscaleBaseUrl(port) {
	const configured =
		process.env.PI_SPEAK_TRAY_BASE_URL?.trim() ||
		process.env.PI_SPEAK_TAILSCALE_BASE_URL?.trim() ||
		process.env.PI_SPEAK_PUBLIC_BASE_URL?.trim();
	if (configured) return configured.endsWith("/") ? configured : `${configured}/`;
	const detected = getReachableIpv4Addresses().tailscale[0];
	if (detected) return `http://${detected}:${port}/`;
	const address = platform() === "darwin" ? TAILSCALE_MAC_IP : TAILSCALE_APPSERVER_IP;
	return `http://${address}:${port}/`;
}

function getSetupProfileForBaseUrl(baseUrl) {
	if (baseUrl.includes(TAILSCALE_MAC_IP)) {
		return { machineId: "tailscale-mac", profileName: "Mac", connectionMode: "tailscale" };
	}
	if (baseUrl.includes("192.168.") || baseUrl.includes("10.") || /172\.(1[6-9]|2\d|3[01])\./.test(baseUrl)) {
		return { machineId: "local-lan", profileName: "Local network", connectionMode: "manual" };
	}
	return { machineId: "tailscale-appserver", profileName: "MSI / appserver", connectionMode: "tailscale" };
}

function buildRemoteSetupUrls(port, token) {
	const fallbackBase = getDefaultTailscaleBaseUrl(port);
	const detected = getReachableIpv4Addresses();
	const tailscaleBases = detected.tailscale.map((address) => `http://${address}:${port}/`);
	const lanBases = detected.lan.map((address) => `http://${address}:${port}/`);
	const baseUrls = [...new Set([...tailscaleBases, ...lanBases, fallbackBase].filter(Boolean))];
	const setupPageUrls = baseUrls.map((baseUrl) => `${baseUrl}setup?token=${encodeURIComponent(token)}`);
	const downloadUrls = baseUrls.map((baseUrl) => `${baseUrl}download/pi-speak.apk`);
	const appSetupUrls = baseUrls.map((baseUrl) => {
		const profile = getSetupProfileForBaseUrl(baseUrl);
		const params = new URLSearchParams({
			base_url: baseUrl,
			token,
			machine_id: profile.machineId,
			profile_name: profile.profileName,
			connection_mode: profile.connectionMode,
		});
		return `pi-speak://setup?${params.toString()}`;
	});
	return { baseUrls, setupPageUrls, downloadUrls, appSetupUrls };
}

async function main() {
	const mode = process.argv.includes("--bluetooth") || process.argv.includes("bluetooth") ? "bluetooth" : "tailscale";
	const urls = buildRemoteSetupUrls(PORT, TOKEN);
	const setupUrl = urls.setupPageUrls[0];
	const baseUrl = urls.baseUrls[0];

	if (!setupUrl) {
		console.error("Could not determine a reachable setup URL.");
		process.exit(1);
	}

	const qr = await QRCode.toString(setupUrl, {
		type: "terminal",
		small: true,
		margin: 1,
		errorCorrectionLevel: "M",
	});

	console.log(mode === "bluetooth" ? "Bluetooth remote setup is ready." : "PK remote setup is ready.");
	console.log(`Base: ${baseUrl}`);
	console.log(`Token: ${TOKEN}`);
	console.log("");
	console.log("Scan this QR from the Android phone to download the app and save this machine:");
	console.log(qr);
	console.log("");
	console.log(`Phone setup page: ${setupUrl}`);
	console.log(`Android APK: ${urls.downloadUrls[0]}`);
	console.log(`Native app setup: ${urls.appSetupUrls[0]}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
