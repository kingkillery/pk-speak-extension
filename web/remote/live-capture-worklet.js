const OUTPUT_SAMPLE_RATE = 16_000;
const OUTPUT_BATCH_SAMPLES = 320;

class PiSpeakLiveCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.inputBuffer = new Float32Array(0);
		this.inputPosition = 0;
		this.outputSamples = [];
		this.ratio = sampleRate / OUTPUT_SAMPLE_RATE;
	}

	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel?.length) return true;
		const combined = new Float32Array(this.inputBuffer.length + channel.length);
		combined.set(this.inputBuffer);
		combined.set(channel, this.inputBuffer.length);
		this.inputBuffer = combined;

		while (this.inputPosition + 1 < this.inputBuffer.length) {
			const left = Math.floor(this.inputPosition);
			const fraction = this.inputPosition - left;
			const sample = this.inputBuffer[left] * (1 - fraction) + this.inputBuffer[left + 1] * fraction;
			this.outputSamples.push(sample);
			this.inputPosition += this.ratio;
		}

		const consumed = Math.min(Math.floor(this.inputPosition), Math.max(0, this.inputBuffer.length - 1));
		if (consumed > 0) {
			this.inputBuffer = this.inputBuffer.slice(consumed);
			this.inputPosition -= consumed;
		}
		while (this.outputSamples.length >= OUTPUT_BATCH_SAMPLES) {
			this.port.postMessage(Float32Array.from(this.outputSamples.splice(0, OUTPUT_BATCH_SAMPLES)));
		}
		return true;
	}
}

registerProcessor("pi-speak-live-capture", PiSpeakLiveCaptureProcessor);
