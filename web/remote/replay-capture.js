/**
 * Bounded PCM retained only while an assistant response is still interruptible.
 * Chunks are held by reference until an interruption creates one stable snapshot.
 */
export const DEFAULT_REPLAY_MAX_SAMPLES = 24_000 * 30;

export class InterruptedAudioReplay {
	/** @param {{ maxSamples?: number }} [options] */
	constructor({ maxSamples = DEFAULT_REPLAY_MAX_SAMPLES } = {}) {
		this.maxSamples = Math.max(1, Math.floor(maxSamples));
		/** @type {Float32Array[]} */
		this.currentChunks = [];
		this.currentSamples = 0;
		this.currentRate = 0;
		/** @type {{ rate: number, chunks: Float32Array[], sampleCount: number } | null} */
		this.snapshot = null;
		this.interruptLatched = false;
	}

	/** @param {Float32Array} samples @param {number} rate */
	capture(samples, rate) {
		if (!(samples instanceof Float32Array) || samples.length === 0 || !Number.isFinite(rate) || rate <= 0) return;
		if (this.currentSamples > 0 && this.currentRate !== rate) this.discardCurrent();
		this.currentRate = rate;
		const remaining = this.maxSamples - this.currentSamples;
		if (remaining <= 0) return;
		const retained = samples.length <= remaining ? samples : samples.slice(0, remaining);
		this.currentChunks.push(retained);
		this.currentSamples += retained.length;
	}

	/** Marks provider output as a later assistant segment that may replace the replay. */
	beginSegment() {
		this.interruptLatched = false;
	}

	/** Freeze the current segment once; an echoed duplicate interrupt leaves it intact. */
	freezeInterrupted() {
		if (this.interruptLatched) {
			// A local interrupt and its echoed server event can straddle a final
			// provider chunk. Drop that tail rather than replacing the useful snapshot.
			this.discardCurrent();
			return false;
		}
		if (this.currentSamples === 0 || !this.currentRate) return false;
		this.snapshot = {
			rate: this.currentRate,
			chunks: this.currentChunks.map((chunk) => chunk.slice()),
			sampleCount: this.currentSamples,
		};
		this.discardCurrent();
		this.interruptLatched = true;
		return true;
	}

	discardCurrent() {
		this.currentChunks = [];
		this.currentSamples = 0;
		this.currentRate = 0;
	}

	clear() {
		this.discardCurrent();
		this.snapshot = null;
		this.interruptLatched = false;
	}

	hasReplay() {
		return this.snapshot !== null;
	}

	/** Returns fresh buffers because playback transfers its inputs to the worklet. */
	getReplay() {
		if (!this.snapshot) return null;
		return {
			rate: this.snapshot.rate,
			chunks: this.snapshot.chunks.map((chunk) => chunk.slice()),
			sampleCount: this.snapshot.sampleCount,
		};
	}
}
