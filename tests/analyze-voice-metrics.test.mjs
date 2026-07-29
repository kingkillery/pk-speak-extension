import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { analyzeVoiceMetrics, computeSha256, percentile, extractJsonObjects, validateManifest } from "../scripts/analyze-voice-metrics.mjs";
import { generateManifestForLog } from "../scripts/generate-campaign-manifest.mjs";

test("percentile calculation computes exact nearest-rank values", () => {
	const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
	assert.equal(percentile(values, 0.5), 500);
	assert.equal(percentile(values, 0.95), 1000);
	assert.equal(percentile([], 0.5), null);
});

test("validateManifest rejects incomplete live provenance metadata or missing provider/model profile", () => {
	const logContent = Buffer.from("sample raw log content\n");
	const logHash = computeSha256(logContent);

	const validLiveManifest = {
		kind: "manifest",
		campaignId: "camp-001",
		timestampUtc: "2026-07-29T12:00:00Z",
		gitCommit: "f253243",
		backendMode: "live",
		browserIdentity: "Chrome 127.0.0.1",
		resolvedBackendImplementation: "openai-realtime-live",
		audioDeviceIdentity: "Default Microphone",
		sampleSource: "live-browser-audio",
		provider: "openai-realtime",
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "server_vad",
		eagerness: "default",
		rawLogHash: logHash,
	};

	const vRes = validateManifest(validLiveManifest, logHash);
	assert.equal(vRes.valid, true);

	// Missing provider
	assert.equal(validateManifest({ ...validLiveManifest, provider: "unspecified" }, logHash).valid, false);

	// Missing turnDetection
	assert.equal(validateManifest({ ...validLiveManifest, turnDetection: "unspecified" }, logHash).valid, false);
});

test("configuration mismatch between manifest and metric items fails closed to UNVERIFIED", () => {
	const logContent = `[pi-speak-voice-metric] {"kind":"turn","provider":"gemini","model":"flash","turnDetection":"server_vad","eagerness":"default","timeToFirstAudioMs":200,"upstreamInferenceMs":150,"localBufferMs":10}\n`;
	const rawHash = computeSha256(logContent);

	const mismatchManifest = {
		kind: "manifest",
		campaignId: "camp-002",
		timestampUtc: "2026-07-29T12:00:00Z",
		gitCommit: "f253243",
		backendMode: "live",
		browserIdentity: "Chrome 127.0.0.1",
		resolvedBackendImplementation: "openai-realtime-live",
		audioDeviceIdentity: "Default Microphone",
		sampleSource: "live-browser-audio",
		provider: "openai-realtime", // Mismatched with metric item provider 'gemini'
		model: "gpt-4o-realtime-preview-2024-12-17",
		turnDetection: "server_vad",
		eagerness: "default",
		rawLogHash: rawHash,
	};

	const parsedObjects = extractJsonObjects(logContent);
	const results = analyzeVoiceMetrics(parsedObjects, Buffer.from(logContent), mismatchManifest);

	assert.equal(results[0].status.includes("UNVERIFIED"), true);
	assert.equal(results[0].status.includes("Configuration mismatch"), true);
});

test("subprocess CLI --require-verified-live with exact manifest configuration binding PASSES", () => {
	const tmpLogPath = join(tmpdir(), `test-verified-live-${Date.now()}.log`);
	const tmpManifestPath = join(tmpdir(), `test-verified-manifest-${Date.now()}.json`);

	try {
		const turnLines = Array.from({ length: 20 }, (_, i) => `[pi-speak-voice-metric] {"kind":"turn","provider":"openai-realtime","model":"gpt-4o","turnDetection":"server_vad","eagerness":"default","timeToFirstAudioMs":300,"upstreamInferenceMs":250,"localBufferMs":10}`).join("\n");
		const bargeLines = Array.from({ length: 5 }, (_, i) => `[pi-speak-voice-metric] {"kind":"barge_in","provider":"openai-realtime","model":"gpt-4o","turnDetection":"server_vad","eagerness":"default","speechOnsetToSilenceMs":180}`).join("\n");
		const rawContent = `${turnLines}\n${bargeLines}\n`;
		
		writeFileSync(tmpLogPath, rawContent, "utf-8");

		// 1. Generate full live provenance manifest bound to target configuration
		const genProc = spawnSync(process.execPath, [
			"scripts/generate-campaign-manifest.mjs",
			"--input", tmpLogPath,
			"--output", tmpManifestPath,
			"--backend", "live",
			"--browser", "Chrome 127.0.0.1 / AudioContext",
			"--resolved-backend", "openai-realtime-live",
			"--audio-device", "Default Microphone (WebAudio)",
			"--sample-source", "live-browser-audio-session",
			"--provider", "openai-realtime",
			"--model", "gpt-4o",
			"--turn-detection", "server_vad",
			"--eagerness", "default",
			"--campaign", "cli-test-campaign-001"
		], { encoding: "utf-8" });
		assert.equal(genProc.status, 0, `Generator CLI failed: ${genProc.stderr}`);

		// 2. Invoke analyzer with --require-verified-live -> Should PASS and exit 0
		const passProc = spawnSync(process.execPath, [
			"scripts/analyze-voice-metrics.mjs",
			"--input", tmpLogPath,
			"--manifest", tmpManifestPath,
			"--require-verified-live"
		], { encoding: "utf-8" });
		assert.equal(passProc.status, 0, `Expected 0 exit status but got ${passProc.status}: ${passProc.stderr}`);

	} finally {
		if (existsSync(tmpLogPath)) unlinkSync(tmpLogPath);
		if (existsSync(tmpManifestPath)) unlinkSync(tmpManifestPath);
	}
});
