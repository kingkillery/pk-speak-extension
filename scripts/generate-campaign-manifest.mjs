#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

function parseArgs() {
	const args = process.argv.slice(2);
	let inputPath = null;
	let outputPath = "campaign-manifest.json";
	let backendMode = "unverified";
	let browserIdentity = "unspecified-browser";
	let campaignId = null;
	let resolvedBackendImplementation = "unspecified";
	let audioDeviceIdentity = "unspecified";
	let sampleSource = "unspecified";
	let provider = "unspecified";
	let model = "unspecified";
	let turnDetection = "unspecified";
	let eagerness = "unspecified";

	for (let i = 0; i < args.length; i++) {
		if ((args[i] === "--input" || args[i] === "-i") && i + 1 < args.length) {
			inputPath = args[i + 1];
			i++;
		} else if ((args[i] === "--output" || args[i] === "-o") && i + 1 < args.length) {
			outputPath = args[i + 1];
			i++;
		} else if ((args[i] === "--backend" || args[i] === "-b") && i + 1 < args.length) {
			backendMode = args[i + 1];
			i++;
		} else if ((args[i] === "--browser") && i + 1 < args.length) {
			browserIdentity = args[i + 1];
			i++;
		} else if ((args[i] === "--campaign" || args[i] === "-c") && i + 1 < args.length) {
			campaignId = args[i + 1];
			i++;
		} else if ((args[i] === "--resolved-backend") && i + 1 < args.length) {
			resolvedBackendImplementation = args[i + 1];
			i++;
		} else if ((args[i] === "--audio-device") && i + 1 < args.length) {
			audioDeviceIdentity = args[i + 1];
			i++;
		} else if ((args[i] === "--sample-source") && i + 1 < args.length) {
			sampleSource = args[i + 1];
			i++;
		} else if ((args[i] === "--provider") && i + 1 < args.length) {
			provider = args[i + 1];
			i++;
		} else if ((args[i] === "--model") && i + 1 < args.length) {
			model = args[i + 1];
			i++;
		} else if ((args[i] === "--turn-detection") && i + 1 < args.length) {
			turnDetection = args[i + 1];
			i++;
		} else if ((args[i] === "--eagerness") && i + 1 < args.length) {
			eagerness = args[i + 1];
			i++;
		}
	}
	return {
		inputPath,
		outputPath,
		backendMode,
		browserIdentity,
		campaignId,
		resolvedBackendImplementation,
		audioDeviceIdentity,
		sampleSource,
		provider,
		model,
		turnDetection,
		eagerness,
	};
}

export function generateManifestForLog(inputPath, options = {}) {
	if (!inputPath || !existsSync(inputPath)) {
		throw new Error(`Input file not found: ${inputPath}`);
	}

	const rawBytes = readFileSync(inputPath);
	const rawLogHash = createHash("sha256").update(rawBytes).digest("hex");

	let gitCommit = "unknown";
	try {
		gitCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
	} catch {}

	const defaultCampaignId = `camp-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 8)}`;

	const manifest = {
		kind: "manifest",
		campaignId: options.campaignId || defaultCampaignId,
		timestampUtc: new Date().toISOString(),
		gitCommit,
		backendMode: options.backendMode || "unverified",
		browserIdentity: options.browserIdentity || "unspecified-browser",
		resolvedBackendImplementation: options.resolvedBackendImplementation || "unspecified",
		audioDeviceIdentity: options.audioDeviceIdentity || "unspecified",
		sampleSource: options.sampleSource || "unspecified",
		provider: options.provider || "unspecified",
		model: options.model || "unspecified",
		turnDetection: options.turnDetection || "unspecified",
		eagerness: options.eagerness || "unspecified",
		rawLogHash,
		notes: options.notes || "Sidecar campaign manifest",
	};

	return manifest;
}

if (process.argv[1] && process.argv[1].endsWith("generate-campaign-manifest.mjs")) {
	try {
		const args = parseArgs();
		if (!args.inputPath) {
			console.error("Usage: node scripts/generate-campaign-manifest.mjs --input <metrics-file> [--output campaign-manifest.json] [--backend live|simulated|unverified] [--provider ...] [--model ...] [--turn-detection ...] [--eagerness ...]");
			process.exit(1);
		}

		const manifest = generateManifestForLog(args.inputPath, args);

		writeFileSync(args.outputPath, JSON.stringify(manifest, null, 2));
		console.log(`Successfully generated sidecar manifest ${args.outputPath} for ${args.inputPath}`);
		console.log(`Backend Mode: ${manifest.backendMode}`);
		console.log(`Target Profile: ${manifest.provider} / ${manifest.model} / ${manifest.turnDetection} (${manifest.eagerness})`);
		console.log(`SHA-256 rawLogHash: ${manifest.rawLogHash}`);
	} catch (e) {
		console.error("Error generating manifest:", e.message);
		process.exit(1);
	}
}
