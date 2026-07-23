import test from "node:test";
import assert from "node:assert/strict";
import {
	DISCOVERY_PATH,
	DISCOVERY_SCHEMA,
	discoverTailnetGateways,
	parseTailscaleStatus,
	probeGatewayDescriptor,
} from "../dist/gateway-discovery.js";

const STATUS_FIXTURE = JSON.stringify({
	Version: "1.86.2",
	Self: { HostName: "msi-1", TailscaleIPs: ["100.93.214.66"], Online: true },
	Peer: {
		"key-mac2": {
			HostName: "mac2",
			DNSName: "mac2.tail1234.ts.net.",
			OS: "macOS",
			Online: true,
			TailscaleIPs: ["100.109.244.1", "fd7a::1"],
		},
		"key-mac": {
			HostName: "mac",
			OS: "macOS",
			Online: false,
			TailscaleIPs: ["100.76.176.119"],
		},
		"key-phone": {
			HostName: "pixel",
			OS: "android",
			Online: true,
			TailscaleIPs: ["100.101.102.103"],
		},
		"key-junk": { Online: true },
	},
});

test("parseTailscaleStatus extracts peers, strips DNS dot, keeps IPv4, skips junk", () => {
	const peers = parseTailscaleStatus(STATUS_FIXTURE);
	assert.equal(peers.length, 3);
	const mac2 = peers.find((peer) => peer.hostName === "mac2");
	assert.equal(mac2.ip, "100.109.244.1");
	assert.equal(mac2.dnsName, "mac2.tail1234.ts.net");
	assert.equal(mac2.online, true);
	assert.equal(peers.find((peer) => peer.hostName === "mac").online, false);
});

test("parseTailscaleStatus returns empty on shape mismatch and throws on bad JSON", () => {
	assert.deepEqual(parseTailscaleStatus("{}"), []);
	assert.deepEqual(parseTailscaleStatus('{"Peer": 7}'), []);
	assert.throws(() => parseTailscaleStatus("not json"));
});

const descriptorResponse = (overrides = {}) => ({
	ok: true,
	json: async () => ({
		schema: DISCOVERY_SCHEMA,
		name: "Pi Speak on mac2",
		serverId: "srv-1",
		version: "0.2.12",
		authRequired: true,
		...overrides,
	}),
});

test("probeGatewayDescriptor accepts a pi-speak descriptor and rejects foreign/failed responses", async () => {
	const good = await probeGatewayDescriptor("http://100.109.244.1:8767", {
		fetchImpl: async (url) => {
			assert.ok(url.endsWith(DISCOVERY_PATH));
			return descriptorResponse();
		},
	});
	assert.equal(good.name, "Pi Speak on mac2");
	assert.equal(good.baseUrl, "http://100.109.244.1:8767");

	const foreign = await probeGatewayDescriptor("http://x", { fetchImpl: async () => descriptorResponse({ schema: "other.v9" }) });
	assert.equal(foreign, undefined);
	const failed = await probeGatewayDescriptor("http://x", { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
	assert.equal(failed, undefined);
	const thrown = await probeGatewayDescriptor("http://x", {
		fetchImpl: async () => {
			throw new Error("refused");
		},
	});
	assert.equal(thrown, undefined);
});

test("discoverTailnetGateways probes only online peers and reports the roster", async () => {
	const probed = [];
	const roster = await discoverTailnetGateways({
		ports: [8767],
		getStatusJson: async () => STATUS_FIXTURE,
		fetchImpl: async (url) => {
			probed.push(url);
			if (url.startsWith("http://100.109.244.1:8767")) return descriptorResponse();
			throw new Error("refused");
		},
	});
	assert.equal(roster.peersProbed, 2, "offline mac and junk peer must not be probed");
	assert.ok(!probed.some((url) => url.includes("100.76.176.119")));
	assert.equal(roster.gateways.length, 1);
	assert.equal(roster.gateways[0].peer.hostName, "mac2");
	assert.equal(roster.gateways[0].descriptor.serverId, "srv-1");
	assert.deepEqual(roster.errors, []);
});

test("discoverTailnetGateways degrades gracefully when tailscale is unavailable", async () => {
	const roster = await discoverTailnetGateways({
		getStatusJson: async () => {
			throw new Error("tailscale not installed");
		},
	});
	assert.deepEqual(roster.gateways, []);
	assert.equal(roster.peersProbed, 0);
	assert.match(roster.errors[0], /tailscale status unavailable/);
});
