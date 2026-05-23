import QRCode from "qrcode";

const PUBLIC_REMOTE_BASE_URL = process.env.PI_SPEAK_PUBLIC_BASE_URL?.trim() || "";
const DEFAULT_REMOTE_HOST = process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0";
const DEFAULT_REMOTE_PORT = Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10);
const DEFAULT_REMOTE_AUTH_TOKEN = process.env.PI_SPEAK_HTTP_TOKEN || "P-K-Haxx1!";
const TAILSCALE_APPSERVER_IP = "100.76.136.91";
const TAILSCALE_MAC_IP = "100.76.176.119";
const DEFAULT_BLUETOOTH_IP = "192.168.44.1";
const AGENT_PROVIDER = (process.env.AGENT_PROVIDER || "pi").trim().toLowerCase();

function normalizeBaseUrl(value) {
	return value.endsWith("/") ? value : `${value}/`;
}

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
	return {
		tailscale: [...new Set(tailscale)],
		lan: [...new Set(lan)],
	};
}

function getDefaultTailscaleBaseUrl(port) {
	const configured =
		process.env.PI_SPEAK_TRAY_BASE_URL?.trim() ||
		process.env.PI_SPEAK_TAILSCALE_BASE_URL?.trim() ||
		process.env.PI_SPEAK_PUBLIC_BASE_URL?.trim();
	if (configured) return normalizeBaseUrl(configured);
	const detected = getReachableIpv4Addresses().tailscale[0];
	if (detected) return `http://${detected}:${port}/`;
	const address = process.platform === "darwin" ? TAILSCALE_MAC_IP : TAILSCALE_APPSERVER_IP;
	return `http://${address}:${port}/`;
}

function getDefaultBluetoothBaseUrl(port) {
	const configured = process.env.PI_SPEAK_BLUETOOTH_BASE_URL?.trim();
	if (configured) return normalizeBaseUrl(configured);
	return `http://${DEFAULT_BLUETOOTH_IP}:${port}/`;
}

function getSetupProfileForBaseUrl(baseUrl, mode = "tailscale") {
	if (mode === "bluetooth") {
		return { machineId: "bluetooth-local", profileName: "Bluetooth / local link", connectionMode: "bluetooth" };
	}
	if (baseUrl.includes(TAILSCALE_MAC_IP)) {
		return { machineId: "tailscale-mac", profileName: "Mac", connectionMode: "tailscale" };
	}
	if (baseUrl.includes("192.168.") || baseUrl.includes("10.") || /172\.(1[6-9]|2\d|3[01])\./.test(baseUrl)) {
		return { machineId: "local-lan", profileName: "Local network", connectionMode: "manual" };
	}
	return { machineId: "tailscale-appserver", profileName: "MSI / appserver", connectionMode: "tailscale" };
}

function buildRemoteSetupUrls(host, port, token, mode = "tailscale", agentProvider) {
	const publicBase = PUBLIC_REMOTE_BASE_URL ? normalizeBaseUrl(PUBLIC_REMOTE_BASE_URL) : "";
	const fallbackBase = getDefaultTailscaleBaseUrl(port);
	const bluetoothBase = getDefaultBluetoothBaseUrl(port);
	const detected = getReachableIpv4Addresses();
	const tailscaleBases = detected.tailscale.map((address) => `http://${address}:${port}/`);
	const lanBases = detected.lan.map((address) => `http://${address}:${port}/`);
	const hostBase = host && host !== "0.0.0.0" && host !== "::" && (isTailscaleIpv4(host) || isPrivateLanIpv4(host))
		? `http://${host}:${port}/`
		: "";
	const baseUrls = mode === "bluetooth"
		? [...new Set([bluetoothBase].filter(Boolean))]
		: [...new Set([publicBase, ...tailscaleBases, hostBase, ...lanBases, fallbackBase].filter(Boolean))];
	const browserUrls = baseUrls.map((baseUrl) => `${baseUrl}app/?token=${encodeURIComponent(token)}`);
	const appSetupUrls = baseUrls.map((baseUrl) => {
		const profile = getSetupProfileForBaseUrl(baseUrl, mode);
		const params = new URLSearchParams({
			base_url: baseUrl,
			token,
			machine_id: profile.machineId,
			profile_name: profile.profileName,
			connection_mode: profile.connectionMode,
		});
		if (agentProvider) {
			params.set("agent_provider", agentProvider);
		}
		return `pi-speak://setup?${params.toString()}`;
	});
	return { baseUrls, browserUrls, appSetupUrls };
}

async function buildRemoteSetupQrText(url) {
	if (!url) return "";
	return QRCode.toString(url, {
		type: "terminal",
		small: true,
		margin: 1,
		errorCorrectionLevel: "M",
	});
}

import { networkInterfaces, platform } from "node:os";

const host = DEFAULT_REMOTE_HOST;
const port = DEFAULT_REMOTE_PORT;
const token = DEFAULT_REMOTE_AUTH_TOKEN;
const mode = process.argv.includes("bluetooth") ? "bluetooth" : "tailscale";
const agentProvider = AGENT_PROVIDER;

const urls = buildRemoteSetupUrls(host, port, token, mode, agentProvider);
const nativeSetupUrl = urls.appSetupUrls[0] || "";
const browserUrl = urls.browserUrls[0] || "/app/";
const qr = await buildRemoteSetupQrText(nativeSetupUrl);

console.log(mode === "bluetooth" ? "Bluetooth remote setup is ready." : "PK remote setup is ready.");
console.log(`\nNative app setup: ${nativeSetupUrl}`);
console.log(`Browser app: ${browserUrl}`);
if (urls.browserUrls.length > 1) {
	console.log(`Other local URLs: ${urls.browserUrls.slice(1).join(" ")}`);
}
console.log("");
if (qr) {
	console.log("Scan this QR from the Android phone to save this machine:");
	console.log(qr);
}
