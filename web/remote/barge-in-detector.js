// @ts-check
/**
 * Shared client barge-in detector for /orb/ and /app/.
 *
 * Goals:
 * - Ignore ambient noise and short transients
 * - Require sustained voiced energy above an adaptive floor
 * - Debounce repeated interrupts with cooldown + release hysteresis
 * - Bootstrap noise floor from quiet-frame percentiles (not arbitrary startup audio)
 *
 * Pure logic (no DOM / AudioContext) so unit tests can drive it directly.
 */

/**
 * @typedef {object} BargeInDetectorOptions
 * @property {number} [absoluteFloor=0.045] Minimum RMS that can ever count as speech.
 * @property {number} [absoluteInterruptFloor=0.05] Minimum RMS that can ever barge-in.
 * @property {number} [maxNoiseFloor=0.12] Upper bound for the adaptive ambient estimate.
 * @property {number} [speechMargin=0.025] RMS above noise floor required to count as voiced.
 * @property {number} [interruptMargin=0.015] Extra RMS above speech threshold for barge-in.
 * @property {number} [noiseAdaptUp=0.08] Rise rate for ambient floor while quiet.
 * @property {number} [noiseAdaptDown=0.25] Faster drop when environment gets quieter.
 * @property {number} [voicedFramesRequired=3] Consecutive voiced frames before barge-in (~120ms @ 40ms).
 * @property {number} [releaseFrames=3] Quiet frames needed to leave user-speaking.
 * @property {number} [cooldownMs=1200] Minimum spacing between barge-in fires.
 * @property {number} [calibrationFrames=24] Startup frames inspected for quiet-percentile bootstrap.
 * @property {number} [calibrationQuietPercentile=0.3] Percentile of startup samples used as ambient.
 * @property {number} [gateThresholdLin=0] Optional linear noise-gate floor (0 = unused).
 */

/**
 * @typedef {object} BargeInSample
 * @property {number} rms
 * @property {number} nowMs
 * @property {boolean} aiPlaying
 * @property {boolean} [muted]
 */

/**
 * @typedef {object} BargeInDecision
 * @property {boolean} interrupt Fire barge-in now.
 * @property {boolean} userSpeaking Sustained user voice present.
 * @property {boolean} speechEnded User voice just released after speaking.
 * @property {boolean} calibrating Still in bootstrap noise learning.
 * @property {number} noiseFloor Current adaptive ambient estimate.
 * @property {number} speechThreshold Effective speech threshold.
 * @property {number} interruptThreshold Effective barge-in threshold.
 */

/**
 * @param {number[]} values
 * @param {number} p
 */
function percentile(values, p) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
	return sorted[index];
}

/**
 * @param {BargeInDetectorOptions} [options]
 */
export function createBargeInDetector(options = {}) {
	const absoluteFloor = Number.isFinite(options.absoluteFloor) ? options.absoluteFloor : 0.045;
	const absoluteInterruptFloor = Number.isFinite(options.absoluteInterruptFloor) ? options.absoluteInterruptFloor : 0.05;
	const maxNoiseFloor = Number.isFinite(options.maxNoiseFloor) ? options.maxNoiseFloor : 0.12;
	const speechMargin = Number.isFinite(options.speechMargin) ? options.speechMargin : 0.025;
	const interruptMargin = Number.isFinite(options.interruptMargin) ? options.interruptMargin : 0.015;
	const noiseAdaptUp = Number.isFinite(options.noiseAdaptUp) ? options.noiseAdaptUp : 0.08;
	const noiseAdaptDown = Number.isFinite(options.noiseAdaptDown) ? options.noiseAdaptDown : 0.25;
	const voicedFramesRequired = Math.max(1, Math.floor(options.voicedFramesRequired ?? 3));
	const releaseFrames = Math.max(1, Math.floor(options.releaseFrames ?? 3));
	const cooldownMs = Math.max(0, Math.floor(options.cooldownMs ?? 1200));
	const calibrationFrames = Math.max(0, Math.floor(options.calibrationFrames ?? 24));
	const calibrationQuietPercentile = Number.isFinite(options.calibrationQuietPercentile)
		? Math.min(1, Math.max(0, options.calibrationQuietPercentile))
		: 0.3;
	let gateThresholdLin = Math.max(0, Number(options.gateThresholdLin) || 0);

	let noiseFloor = Math.min(absoluteFloor * 0.5, maxNoiseFloor);
	let voicedRun = 0;
	let quietRun = 0;
	let userSpeaking = false;
	let lastInterruptAt = 0;
	let framesSeen = 0;
	/** @type {number[]} */
	const calibrationSamples = [];

	/**
	 * @param {number} thresholdDb
	 * @param {boolean} [enabled=true]
	 */
	function setGateThresholdDb(thresholdDb, enabled = true) {
		if (!enabled || !Number.isFinite(thresholdDb)) {
			gateThresholdLin = 0;
			return;
		}
		gateThresholdLin = Math.pow(10, thresholdDb / 20);
	}

	function thresholdsFor() {
		const speechThreshold = Math.max(absoluteFloor, noiseFloor + speechMargin, gateThresholdLin);
		const interruptThreshold = Math.max(
			speechThreshold + interruptMargin,
			absoluteInterruptFloor,
			noiseFloor + speechMargin + interruptMargin,
			gateThresholdLin,
		);
		return { speechThreshold, interruptThreshold, noiseFloor };
	}

	/**
	 * @param {number} rms
	 * @param {{ aiPlaying?: boolean }} [opts]
	 */
	function adaptNoiseFloor(rms, opts = {}) {
		if (userSpeaking) return;
		const aiPlaying = !!opts.aiPlaying;
		const alpha = rms < noiseFloor ? noiseAdaptDown : (aiPlaying ? noiseAdaptUp * 0.5 : noiseAdaptUp);
		noiseFloor = noiseFloor + (rms - noiseFloor) * alpha;
		noiseFloor = Math.min(Math.max(noiseFloor, 0.005), maxNoiseFloor);
	}

	function finalizeCalibration() {
		if (!calibrationSamples.length) {
			noiseFloor = Math.min(absoluteFloor * 0.5, maxNoiseFloor);
			return;
		}
		// Use a low percentile so brief startup speech does not poison ambient.
		const quietEstimate = percentile(calibrationSamples, calibrationQuietPercentile);
		noiseFloor = Math.min(Math.max(quietEstimate, 0.005), maxNoiseFloor);
	}

	/**
	 * @param {BargeInSample} sample
	 * @returns {BargeInDecision}
	 */
	function observe(sample) {
		const rms = Math.max(0, Number(sample.rms) || 0);
		const nowMs = Number.isFinite(sample.nowMs) ? sample.nowMs : Date.now();
		const aiPlaying = !!sample.aiPlaying;
		const muted = !!sample.muted;
		framesSeen += 1;
		const calibrating = framesSeen <= calibrationFrames;

		if (muted) {
			voicedRun = 0;
			quietRun = releaseFrames;
			const wasSpeaking = userSpeaking;
			userSpeaking = false;
			const { speechThreshold, interruptThreshold } = thresholdsFor();
			return {
				interrupt: false,
				userSpeaking: false,
				speechEnded: wasSpeaking,
				calibrating,
				noiseFloor,
				speechThreshold,
				interruptThreshold,
			};
		}

		if (calibrating) {
			calibrationSamples.push(rms);
			// Live preview floor from current quiet percentile; barge-in remains disarmed.
			noiseFloor = Math.min(
				Math.max(percentile(calibrationSamples, calibrationQuietPercentile), 0.005),
				maxNoiseFloor,
			);
			if (framesSeen === calibrationFrames) finalizeCalibration();
			const { speechThreshold, interruptThreshold } = thresholdsFor();
			return {
				interrupt: false,
				userSpeaking: false,
				speechEnded: false,
				calibrating: true,
				noiseFloor,
				speechThreshold,
				interruptThreshold,
			};
		}

		const probe = thresholdsFor();
		const candidateSpeech = rms >= probe.interruptThreshold;

		// Adapt only on non-candidate quiet-ish frames.
		if (!candidateSpeech) {
			adaptNoiseFloor(rms, { aiPlaying });
		}

		const { speechThreshold, interruptThreshold } = thresholdsFor();
		const voiced = rms >= speechThreshold;
		const bargeCandidate = aiPlaying && rms >= interruptThreshold;

		if (voiced) {
			voicedRun += 1;
			quietRun = 0;
		} else {
			quietRun += 1;
			voicedRun = 0;
		}

		let speechEnded = false;
		if (!userSpeaking && voicedRun >= voicedFramesRequired) {
			userSpeaking = true;
		} else if (userSpeaking && quietRun >= releaseFrames) {
			userSpeaking = false;
			speechEnded = true;
		}

		const cooledDown = nowMs - lastInterruptAt >= cooldownMs;
		const interrupt = bargeCandidate && voicedRun >= voicedFramesRequired && cooledDown;
		if (interrupt) {
			lastInterruptAt = nowMs;
			userSpeaking = true;
			quietRun = 0;
		}

		return {
			interrupt,
			userSpeaking,
			speechEnded,
			calibrating: false,
			noiseFloor,
			speechThreshold,
			interruptThreshold,
		};
	}

	function reset() {
		noiseFloor = Math.min(absoluteFloor * 0.5, maxNoiseFloor);
		voicedRun = 0;
		quietRun = 0;
		userSpeaking = false;
		lastInterruptAt = 0;
		framesSeen = 0;
		calibrationSamples.length = 0;
	}

	return {
		observe,
		setGateThresholdDb,
		reset,
		/** @internal test helper */
		getState: () => ({
			noiseFloor,
			voicedRun,
			quietRun,
			userSpeaking,
			lastInterruptAt,
			gateThresholdLin,
			framesSeen,
			calibrationFrames,
			calibrationSamples: [...calibrationSamples],
		}),
	};
}

/**
 * Compute mono RMS from Int16 PCM.
 * @param {Int16Array | ArrayLike<number>} int16
 */
export function rmsFromInt16(int16) {
	const n = int16?.length || 0;
	if (!n) return 0;
	let energy = 0;
	for (let i = 0; i < n; i += 1) {
		const s = int16[i] / 0x8000;
		energy += s * s;
	}
	return Math.sqrt(energy / n);
}
