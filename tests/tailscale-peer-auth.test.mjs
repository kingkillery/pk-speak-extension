import test from "node:test";
import assert from "node:assert/strict";

import {
	createTailscalePeerVerifier,
	isTailscalePeerAddress,
	isVerifiedTailscaleWhois,
	normalizeTailnetPeerAddress,
} from "../dist/tailscale-peer-auth.js";

function whoisJson(address, overrides = {}) {
	return JSON.stringify({
		Node: {
			ID: 42,
			StableID: "node-stable-id",
			Name: "pixel.tailnet.example.",
			Addresses: [`${address}/32`],
			...overrides,
		},
		UserProfile: { ID: 7, LoginName: "operator@example.test" },
	});
}

test("normalizes socket addresses and limits daemon lookups to Tailscale ranges", () => {
	assert.equal(normalizeTailnetPeerAddress("::ffff:100.72.61.52"), "100.72.61.52");
	assert.equal(normalizeTailnetPeerAddress("[fd7a:115c:a1e0::1234]"), "fd7a:115c:a1e0::1234");
	assert.equal(isTailscalePeerAddress("100.64.0.1"), true);
	assert.equal(isTailscalePeerAddress("100.127.255.254"), true);
	assert.equal(isTailscalePeerAddress("fd7a:115c:a1e0::1234"), true);
	assert.equal(isTailscalePeerAddress("100.128.0.1"), false);
	assert.equal(isTailscalePeerAddress("10.0.0.5"), false);
});

test("accepts only a matching daemon identity and rejects Funnel ingress", () => {
	assert.equal(isVerifiedTailscaleWhois(whoisJson("100.72.61.52"), "100.72.61.52"), true);
	assert.equal(isVerifiedTailscaleWhois(whoisJson("100.72.61.53"), "100.72.61.52"), false);
	assert.equal(isVerifiedTailscaleWhois("{}", "100.72.61.52"), false);
	assert.equal(isVerifiedTailscaleWhois("not-json", "100.72.61.52"), false);
	assert.equal(
		isVerifiedTailscaleWhois(whoisJson("100.72.61.52", { Tags: ["tag:ingress"] }), "100.72.61.52"),
		false,
	);
	assert.equal(
		isVerifiedTailscaleWhois(whoisJson("100.72.61.52", { Name: "funnel-ingress-node" }), "100.72.61.52"),
		false,
	);
	assert.equal(
		isVerifiedTailscaleWhois(whoisJson("100.72.61.52", { ShareeNode: true }), "100.72.61.52"),
		false,
	);
	assert.equal(
		isVerifiedTailscaleWhois(whoisJson("100.72.61.52", { Hostinfo: { ShareeNode: true } }), "100.72.61.52"),
		false,
	);
});

test("verifier passes the transport endpoint to WhoIs and caches the daemon result", async () => {
	const targets = [];
	const verifier = createTailscalePeerVerifier({
		lookup: async (target) => {
			targets.push(target);
			return whoisJson("100.72.61.52");
		},
	});

	assert.equal(await verifier("::ffff:100.72.61.52", 43123), true);
	assert.equal(await verifier("100.72.61.52", 43124), true);
	assert.deepEqual(targets, ["100.72.61.52:43123"]);
	assert.equal(await verifier("192.168.1.20", 43125), false);
	assert.equal(targets.length, 1, "ordinary LAN addresses never reach tailscaled WhoIs");
});

test("verifier fails closed and negatively caches daemon errors", async () => {
	let calls = 0;
	const verifier = createTailscalePeerVerifier({
		lookup: async () => {
			calls += 1;
			throw new Error("daemon unavailable");
		},
	});

	assert.equal(await verifier("100.72.61.52"), false);
	assert.equal(await verifier("100.72.61.52"), false);
	assert.equal(calls, 1);
});
