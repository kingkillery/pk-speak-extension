import test from "node:test";
import assert from "node:assert/strict";

const stt = await import("../dist/stt.js");

async function withEnv(patch, run) {
	const previous = {};
	for (const key of Object.keys(patch)) {
		previous[key] = process.env[key];
		const value = patch[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("transcribeAudioBuffer allowProviderFallback:false surfaces OpenAI 429 instead of silent local fallback", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "openai",
				OPENAI_API_KEY: "test-openai-key",
				VOICE_TOOLS_OPENAI_KEY: undefined,
				PI_SPEAK_OPENAI_KEY: undefined,
				ELEVENLABS_API_KEY: undefined,
				XI_API_KEY: undefined,
			},
			async () => {
				await assert.rejects(
					() => stt.transcribeAudioBuffer(Buffer.from("fake-audio"), "audio/wav", { allowProviderFallback: false }),
					(error) => {
						assert.match(String(error?.message || error), /OpenAI transcription failed \(429\)/);
						return true;
					},
				);
				assert.equal(fetchCalls, 1);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await stt.shutdownLocalSttWorker();
	}
});

test("transcribeAudioBuffer still accepts AbortSignal as the third argument", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		return new Response(JSON.stringify({ text: "hello from openai" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "openai",
				OPENAI_API_KEY: "test-openai-key",
				VOICE_TOOLS_OPENAI_KEY: undefined,
				PI_SPEAK_OPENAI_KEY: undefined,
				ELEVENLABS_API_KEY: undefined,
				XI_API_KEY: undefined,
			},
			async () => {
				const controller = new AbortController();
				const result = await stt.transcribeAudioBuffer(
					Buffer.from("fake-audio"),
					"audio/wav",
					controller.signal,
				);
				assert.equal(result.provider, "openai");
				assert.equal(result.text, "hello from openai");
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await stt.shutdownLocalSttWorker();
	}
});
