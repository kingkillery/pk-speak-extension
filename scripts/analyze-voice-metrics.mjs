#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

export function parseArgs(argv = process.argv.slice(2)) {
	let inputPath = null;
	let manifestPath = null;
	let requireVerifiedLive = false;

	for (let i = 0; i < argv.length; i++) {
		if ((argv[i] === "--input" || argv[i] === "-i") && i + 1 < argv.length) {
			inputPath = argv[i + 1];
			i++;
		} else if ((argv[i] === "--manifest" || argv[i] === "-m") && i + 1 < argv.length) {
			manifestPath = argv[i + 1];
			i++;
		} else if (argv[i] === "--require-verified-live") {
			requireVerifiedLive = true;
		} else if (!argv[i].startsWith("-") && !inputPath) {
			inputPath = argv[i];
		}
	}
	return { inputPath, manifestPath, requireVerifiedLive };
}

export function computeSha256(content) {
	if (!content) return "";
	const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf-8");
	return createHash("sha256").update(buffer).digest("hex");
}

export function percentile(values, p) {
	if (!values || values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[index];
}

function formatMs(val) {
	if (val === null || val === undefined || isNaN(val)) return "—";
	return `${Math.round(val)} ms`;
}

export function extractJsonObjects(text) {
	const objects = [];
	if (!text || typeof text !== "string") return objects;

	const trimmed = text.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed;
		} catch {}
	}

	const lines = text.split("\n");
	for (const line of lines) {
		let jsonStr = line.trim();
		const tagIdx = jsonStr.indexOf("[pi-speak-voice-metric]");
		if (tagIdx !== -1) {
			jsonStr = jsonStr.slice(tagIdx + "[pi-speak-voice-metric]".length).trim();
		}
		if (jsonStr.startsWith("{") && jsonStr.endsWith("}")) {
			try {
				objects.push(JSON.parse(jsonStr));
			} catch {}
		}
	}
	return objects;
}

export function validateManifest(manifest, computedLogHash = null) {
	if (!manifest || typeof manifest !== "object") {
		return { valid: false, reason: "Missing or non-object manifest" };
	}

	const {
		campaignId,
		timestampUtc,
		gitCommit,
		backendMode,
		browserIdentity,
		rawLogHash,
		resolvedBackendImplementation,
		audioDeviceIdentity,
		sampleSource,
		provider,
		model,
		turnDetection,
		eagerness,
	} = manifest;

	if (!campaignId || typeof campaignId !== "string") {
		return { valid: false, reason: "Missing required manifest field: campaignId" };
	}
	if (!timestampUtc || typeof timestampUtc !== "string") {
		return { valid: false, reason: "Missing required manifest field: timestampUtc" };
	}
	if (!rawLogHash || typeof rawLogHash !== "string") {
		return { valid: false, reason: "Missing required manifest field: rawLogHash" };
	}

	if (computedLogHash && rawLogHash !== computedLogHash) {
		return { valid: false, reason: `SHA-256 rawLogHash mismatch (manifest: ${rawLogHash}, computed: ${computedLogHash})` };
	}

	if (backendMode !== "live" && backendMode !== "simulated") {
		return { valid: false, reason: "Invalid backendMode: must be 'live' or 'simulated'" };
	}

	// Strict checks for live provenance manifests
	if (backendMode === "live") {
		if (!gitCommit || typeof gitCommit !== "string" || gitCommit === "unknown") {
			return { valid: false, reason: "Live manifest rejects unknown or missing gitCommit" };
		}
		if (!browserIdentity || typeof browserIdentity !== "string" || browserIdentity === "unspecified-browser") {
			return { valid: false, reason: "Live manifest rejects unspecified-browser identity" };
		}
		if (!resolvedBackendImplementation || typeof resolvedBackendImplementation !== "string" || resolvedBackendImplementation === "unspecified") {
			return { valid: false, reason: "Live manifest requires valid resolvedBackendImplementation" };
		}
		if (!audioDeviceIdentity || typeof audioDeviceIdentity !== "string" || audioDeviceIdentity === "unspecified") {
			return { valid: false, reason: "Live manifest requires valid audioDeviceIdentity" };
		}
		if (!sampleSource || typeof sampleSource !== "string" || sampleSource === "unspecified") {
			return { valid: false, reason: "Live manifest requires valid sampleSource" };
		}
		if (!provider || typeof provider !== "string" || provider === "unspecified") {
			return { valid: false, reason: "Live manifest requires valid provider" };
		}
		if (!model || typeof model !== "string" || model === "unspecified") {
			return { valid: false, reason: "Live manifest requires valid model" };
		}
		if (!turnDetection || typeof turnDetection !== "string" || turnDetection === "unspecified") {
			return { valid: false, reason: "Live manifest requires valid turnDetection" };
		}
		if (!eagerness || typeof eagerness !== "string" || eagerness === "unspecified") {
			return { valid: false, reason: "Live manifest requires valid eagerness profile" };
		}
	}

	return { valid: true, manifest };
}

export function analyzeVoiceMetrics(rawPayloads, rawContent = null, sidecarManifest = null) {
	const computedLogHash = rawContent ? computeSha256(rawContent) : null;
	
	let manifestValidation = { valid: false, reason: "No sidecar manifest provided (--manifest)" };
	let activeManifest = sidecarManifest;

	if (!activeManifest) {
		const inlineManifests = rawPayloads.filter((item) => item && typeof item === "object" && item.kind === "manifest");
		if (inlineManifests.length === 1) {
			activeManifest = inlineManifests[0];
		}
	}

	if (activeManifest) {
		manifestValidation = validateManifest(activeManifest, computedLogHash);
	}

	const groups = new Map();

	for (const item of rawPayloads) {
		if (!item || typeof item !== "object") continue;
		if (item.kind === "manifest") continue;

		const kind = item.kind;
		if (kind !== "turn" && kind !== "barge_in") continue;

		// Verify metric item matches active manifest configuration if manifest is present
		if (activeManifest && manifestValidation.valid) {
			if (activeManifest.provider && item.provider && item.provider !== activeManifest.provider) {
				manifestValidation = { valid: false, reason: `Configuration mismatch: item provider '${item.provider}' !== manifest provider '${activeManifest.provider}'` };
			}
			if (activeManifest.model && item.model && item.model !== activeManifest.model) {
				manifestValidation = { valid: false, reason: `Configuration mismatch: item model '${item.model}' !== manifest model '${activeManifest.model}'` };
			}
			if (activeManifest.turnDetection && item.turnDetection && item.turnDetection !== activeManifest.turnDetection) {
				manifestValidation = { valid: false, reason: `Configuration mismatch: item turnDetection '${item.turnDetection}' !== manifest turnDetection '${activeManifest.turnDetection}'` };
			}
			if (activeManifest.eagerness && item.eagerness && item.eagerness !== activeManifest.eagerness) {
				manifestValidation = { valid: false, reason: `Configuration mismatch: item eagerness '${item.eagerness}' !== manifest eagerness '${activeManifest.eagerness}'` };
			}
		}

		const campaignId = activeManifest?.campaignId || "untracked-campaign";
		const backendMode = activeManifest?.backendMode || "unspecified";
		const provider = item.provider || activeManifest?.provider || "gemini";
		const model = item.model || activeManifest?.model || "default";
		const turnDetection = item.turnDetection || activeManifest?.turnDetection || "server_vad";
		const eagerness = item.eagerness || activeManifest?.eagerness || "default";

		const groupKey = `${campaignId}|${backendMode}|${provider}|${model}|${turnDetection}|${eagerness}`;
		if (!groups.has(groupKey)) {
			groups.set(groupKey, {
				campaignId,
				backendMode,
				provider,
				model,
				turnDetection,
				eagerness,
				turnSamples: [],
				bargeInSamples: [],
			});
		}

		const g = groups.get(groupKey);

		if (kind === "turn") {
			const timeToFirstAudio = item.timeToFirstAudioMs ?? (item.firstSampleRenderedClientMs - item.vadSpeechEndClientMs);
			const upstreamInference = item.upstreamInferenceMs ?? (item.firstUpstreamEventMs - item.lastPcmSentUpstreamMs);
			const localBuffer = item.localBufferMs ?? (item.firstSampleRenderedClientMs - item.firstPcmEnqueuedClientMs);

			if (Number.isFinite(timeToFirstAudio) && Number.isFinite(upstreamInference) && Number.isFinite(localBuffer)) {
				g.turnSamples.push({
					timeToFirstAudio,
					upstreamInference,
					localBuffer,
				});
			}
		} else if (kind === "barge_in") {
			const silenceMs = item.speechOnsetToSilenceMs ?? (item.playbackSilencedClientMs - item.speechOnsetClientMs);
			if (Number.isFinite(silenceMs)) {
				const sample = { silenceMs };
				if (typeof item.audibleTail === "boolean") {
					sample.audibleTail = item.audibleTail;
				}
				g.bargeInSamples.push(sample);
			}
		}
	}

	const rows = [];
	for (const g of groups.values()) {
		const validTurnsCount = g.turnSamples.length;
		const validBargeInCount = g.bargeInSamples.length;

		const timeToFirstAudioVals = g.turnSamples.map((s) => s.timeToFirstAudio);
		const upstreamVals = g.turnSamples.map((s) => s.upstreamInference);
		const bufferVals = g.turnSamples.map((s) => s.localBuffer);
		const bargeInVals = g.bargeInSamples.map((s) => s.silenceMs);

		const p50TTFA = percentile(timeToFirstAudioVals, 0.5);
		const p95TTFA = percentile(timeToFirstAudioVals, 0.95);
		const p95Upstream = percentile(upstreamVals, 0.95);
		const p95Buffer = percentile(bufferVals, 0.95);
		const p95BargeIn = percentile(bargeInVals, 0.95);

		let profileLabel = `${g.provider} / ${g.model} / ${g.turnDetection}`;
		if (g.eagerness && g.eagerness !== "default") {
			profileLabel += ` (${g.eagerness})`;
		}
		if (g.backendMode === "simulated") {
			profileLabel += " [Synthetic Fixture]";
		} else if (g.backendMode === "unspecified" || !manifestValidation.valid) {
			profileLabel += ` [Unverified: ${manifestValidation.reason}]`;
		}

		let bargeInText = "—";
		if (p95BargeIn !== null) {
			bargeInText = `${Math.round(p95BargeIn)} ms`;
			const explicitTailSamples = g.bargeInSamples.filter((s) => typeof s.audibleTail === "boolean");
			if (explicitTailSamples.length > 0) {
				const anyTail = explicitTailSamples.some((s) => s.audibleTail === true);
				bargeInText += anyTail ? " / audible tail detected" : " / no audible tail";
			}
		}

		let status = "**UNVERIFIED / UNMEASURED**";
		if (!manifestValidation.valid) {
			status = `**UNVERIFIED (${manifestValidation.reason})**`;
		} else if (g.backendMode === "simulated") {
			status = "**SYNTHETIC FIXTURE**";
		} else if (g.backendMode === "live") {
			if (validTurnsCount >= 20 && validBargeInCount >= 5) {
				const passBargeIn = p95BargeIn !== null && p95BargeIn < 200;
				status = passBargeIn ? "**PASS**" : "**FAIL**";
			} else {
				status = `**INCOMPLETE (${validTurnsCount} turns, ${validBargeInCount} barge-ins)**`;
			}
		}

		rows.push({
			campaignId: g.campaignId,
			profileLabel,
			provider: g.provider,
			model: g.model,
			turnDetection: g.turnDetection,
			eagerness: g.eagerness,
			backendMode: g.backendMode,
			turns: validTurnsCount,
			bargeIns: validBargeInCount,
			p50TTFA,
			p95TTFA,
			p95Upstream,
			p95Buffer,
			p95BargeIn,
			bargeInText,
			status,
			manifestValidation,
		});
	}

	return rows;
}

export function generateMarkdownTable(rows) {
	let md = "| Backend / model / VAD profile | Turns | p50 first audio | p95 first audio | p95 upstream | p95 local buffer | Barge-in p95 / audible tail | Status |\n";
	md += "|---|---:|---:|---:|---:|---:|---:|---|\n";

	if (rows.length === 0) {
		md += "| (No voice metrics found) | 0 | — | — | — | — | — | **UNMEASURED** |\n";
		return md;
	}

	for (const r of rows) {
		md += `| ${r.profileLabel} | ${r.turns} | ${formatMs(r.p50TTFA)} | ${formatMs(r.p95TTFA)} | ${formatMs(r.p95Upstream)} | ${formatMs(r.p95Buffer)} | ${r.bargeInText} | ${r.status} |\n`;
	}

	return md;
}

// Main CLI execution
if (process.argv[1] && process.argv[1].endsWith("analyze-voice-metrics.mjs")) {
	const { inputPath, manifestPath, requireVerifiedLive } = parseArgs();
	let content = "";
	let rawContentBuffer = null;

	if (inputPath) {
		rawContentBuffer = readFileSync(inputPath);
		content = rawContentBuffer.toString("utf-8");
	} else {
		try {
			rawContentBuffer = readFileSync(0);
			content = rawContentBuffer.toString("utf-8");
		} catch {}
	}

	let sidecarManifest = null;
	if (manifestPath && existsSync(manifestPath)) {
		try {
			sidecarManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		} catch (e) {
			console.error(`Error reading sidecar manifest ${manifestPath}:`, e.message);
		}
	}

	const jsonObjects = extractJsonObjects(content);
	const results = analyzeVoiceMetrics(jsonObjects, rawContentBuffer, sidecarManifest);
	const tableMd = generateMarkdownTable(results);

	console.log(tableMd);

	if (requireVerifiedLive) {
		const unverifiedOrSynthetic = results.filter(
			(r) =>
				r.status.includes("UNVERIFIED") ||
				r.status.includes("SYNTHETIC") ||
				r.status.includes("INCOMPLETE") ||
				r.status.includes("UNMEASURED")
		);
		if (results.length === 0 || unverifiedOrSynthetic.length > 0) {
			console.error("\n❌ CLI FAILURE (--require-verified-live): One or more analyzed groups failed verification or lack verified live provenance.");
			process.exit(1);
		}
	}
}
