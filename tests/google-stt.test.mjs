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

function clearGoogleOverride() {
	stt.testOverrides.createGoogleSpeechClient = null;
}

async function isolateGoogleClientCache() {
	clearGoogleOverride();
	await stt.shutdownLocalSttWorker();
}

test("resolveSttProvider auto order stays elevenlabs -> openai -> local (google never auto)", async () => {
	await withEnv(
		{
			PI_SPEAK_REMOTE_STT_PROVIDER: "auto",
			ELEVENLABS_API_KEY: undefined,
			XI_API_KEY: undefined,
			OPENAI_API_KEY: undefined,
			VOICE_TOOLS_OPENAI_KEY: undefined,
			PI_SPEAK_OPENAI_KEY: undefined,
			GOOGLE_CLOUD_PROJECT: "proj-should-not-auto-select",
		},
		async () => {
			assert.equal(stt.resolveSttProvider(), "local");
		},
	);

	await withEnv(
		{
			PI_SPEAK_REMOTE_STT_PROVIDER: "auto",
			ELEVENLABS_API_KEY: undefined,
			XI_API_KEY: undefined,
			OPENAI_API_KEY: "openai-key",
			VOICE_TOOLS_OPENAI_KEY: undefined,
			PI_SPEAK_OPENAI_KEY: undefined,
			GOOGLE_CLOUD_PROJECT: "proj-should-not-auto-select",
		},
		async () => {
			assert.equal(stt.resolveSttProvider(), "openai");
		},
	);

	await withEnv(
		{
			PI_SPEAK_REMOTE_STT_PROVIDER: "auto",
			ELEVENLABS_API_KEY: "el-key",
			XI_API_KEY: undefined,
			OPENAI_API_KEY: "openai-key",
			GOOGLE_CLOUD_PROJECT: "proj-should-not-auto-select",
		},
		async () => {
			assert.equal(stt.resolveSttProvider(), "elevenlabs");
		},
	);

	await withEnv(
		{
			PI_SPEAK_REMOTE_STT_PROVIDER: "google",
			GOOGLE_CLOUD_PROJECT: "explicit-google",
		},
		async () => {
			assert.equal(stt.resolveSttProvider(), "google");
		},
	);
});

test("google STT uses env project, recognizer/config/content, and flattens transcript", async () => {
	await isolateGoogleClientCache();
	const calls = [];
	let closeCalls = 0;
	stt.testOverrides.createGoogleSpeechClient = async ({ apiEndpoint, location }) => {
		calls.push({ phase: "create", apiEndpoint, location });
		return {
			async getProjectId() {
				throw new Error("ADC project lookup should not be required when env project is set");
			},
			async recognize(request, options) {
				calls.push({ phase: "recognize", request, options });
				return [
					{
						results: [
							{ alternatives: [{ transcript: "  hello" }, { transcript: "ignored" }] },
							{ alternatives: [{ transcript: "world  " }] },
						],
					},
				];
			},
			async close() {
				closeCalls += 1;
			},
		};
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "demo-project",
				GCLOUD_PROJECT: undefined,
				PI_SPEAK_VERTEX_PROJECT: undefined,
				PI_SPEAK_GOOGLE_STT_LOCATION: undefined,
				PI_SPEAK_GOOGLE_STT_MODEL: undefined,
				PI_SPEAK_STT_LANGUAGE: undefined,
				PI_SPEAK_OUTBOUND_TIMEOUT_MS: undefined,
				ELEVENLABS_API_KEY: undefined,
				XI_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
				VOICE_TOOLS_OPENAI_KEY: undefined,
				PI_SPEAK_OPENAI_KEY: undefined,
			},
			async () => {
				const result = await stt.transcribeAudioBuffer(Buffer.from("fake-audio-bytes"), "audio/wav");
				assert.equal(result.provider, "google");
				assert.equal(result.text, "hello world");
				assert.equal(calls[0].apiEndpoint, "speech.googleapis.com");
				assert.equal(calls[0].location, "global");
				const request = calls[1].request;
				assert.equal(request.recognizer, "projects/demo-project/locations/global/recognizers/_");
				assert.deepEqual(request.config, {
					autoDecodingConfig: {},
					model: "chirp_3",
					languageCodes: ["en-US"],
				});
				assert.ok(Buffer.isBuffer(request.content));
				assert.equal(request.content.equals(Buffer.from("fake-audio-bytes")), true);
				assert.deepEqual(calls[1].options, { timeout: 30000 });
				assert.equal(closeCalls, 0, "successful Google STT keeps the cached client open");
				await stt.shutdownLocalSttWorker();
				assert.equal(closeCalls, 1, "shutdownLocalSttWorker closes the cached Google client");
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});

test("google STT discovers project via client.getProjectId when env project is missing", async () => {
	await isolateGoogleClientCache();
	let recognizedProject = "";
	let createArgs;
	let closeCalls = 0;
	stt.testOverrides.createGoogleSpeechClient = async (options) => {
		createArgs = options;
		return {
			async getProjectId() {
				return "adc-discovered-project";
			},
			async recognize(request) {
				recognizedProject = request.recognizer;
				return [{ results: [{ alternatives: [{ transcript: "from adc" }] }] }];
			},
			async close() {
				closeCalls += 1;
			},
		};
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: undefined,
				GCLOUD_PROJECT: undefined,
				PI_SPEAK_VERTEX_PROJECT: undefined,
				PI_SPEAK_GOOGLE_STT_LOCATION: "us-central1",
				PI_SPEAK_GOOGLE_STT_MODEL: "chirp_3",
				PI_SPEAK_STT_LANGUAGE: "en-GB",
			},
			async () => {
				const result = await stt.transcribeAudioBuffer(Buffer.from("abc"), "audio/wav", {
					allowProviderFallback: false,
				});
				assert.equal(result.provider, "google");
				assert.equal(result.text, "from adc");
				assert.equal(
					recognizedProject,
					"projects/adc-discovered-project/locations/us-central1/recognizers/_",
				);
				assert.equal(createArgs.location, "us-central1");
				assert.equal(createArgs.apiEndpoint, "us-central1-speech.googleapis.com");
				assert.equal(closeCalls, 0, "successful Google STT keeps the cached client open");
				await stt.shutdownLocalSttWorker();
				assert.equal(closeCalls, 1, "shutdownLocalSttWorker closes the cached Google client");
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});

test("google STT missing project yields actionable GOOGLE_CLOUD_PROJECT/ADC error", async () => {
	await isolateGoogleClientCache();
	let closeCalls = 0;
	stt.testOverrides.createGoogleSpeechClient = async () => ({
		async getProjectId() {
			throw new Error("Could not load the default credentials");
		},
		async recognize() {
			throw new Error("recognize should not be called");
		},
		async close() {
			closeCalls += 1;
		},
	});

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: undefined,
				GCLOUD_PROJECT: undefined,
				PI_SPEAK_VERTEX_PROJECT: undefined,
			},
			async () => {
				await assert.rejects(
					() => stt.transcribeAudioBuffer(Buffer.from("abc"), "audio/wav", { allowProviderFallback: false }),
					(error) => {
						assert.match(String(error?.message || error), /GOOGLE_CLOUD_PROJECT/);
						assert.match(String(error?.message || error), /Application Default Credentials|ADC/i);
						return true;
					},
				);
				assert.equal(closeCalls, 0, "non-cancel project errors keep the cached client open");
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});

test("allowProviderFallback:false surfaces Google 429 and never calls OpenAI fallback", async () => {
	await isolateGoogleClientCache();
	let recognizeCalls = 0;
	let closeCalls = 0;
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response(JSON.stringify({ text: "should-not-fallback" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};

	stt.testOverrides.createGoogleSpeechClient = async () => ({
		async getProjectId() {
			return "proj";
		},
		async recognize() {
			recognizeCalls += 1;
			const error = new Error("quota exceeded");
			error.code = 8; // RESOURCE_EXHAUSTED
			throw error;
		},
		async close() {
			closeCalls += 1;
		},
	});

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "proj",
				OPENAI_API_KEY: "test-openai-key",
				VOICE_TOOLS_OPENAI_KEY: undefined,
				PI_SPEAK_OPENAI_KEY: undefined,
				ELEVENLABS_API_KEY: undefined,
				XI_API_KEY: undefined,
			},
			async () => {
				await assert.rejects(
					() =>
						stt.transcribeAudioBuffer(Buffer.from("fake-audio"), "audio/wav", {
							allowProviderFallback: false,
						}),
					(error) => {
						assert.match(String(error?.message || error), /Google transcription failed \(429\)/);
						return true;
					},
				);
				assert.equal(recognizeCalls, 1);
				assert.equal(fetchCalls, 0);
				assert.equal(closeCalls, 0, "retryable Google errors keep the cached client open");
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await isolateGoogleClientCache();
	}
});

test("allowProviderFallback:true retries Google 429 to OpenAI when keyed", async () => {
	await isolateGoogleClientCache();
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	let closeCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return new Response(JSON.stringify({ text: "  openai fallback text  " }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};

	stt.testOverrides.createGoogleSpeechClient = async () => ({
		async getProjectId() {
			return "proj";
		},
		async recognize() {
			const error = new Error("unavailable");
			error.code = 14; // UNAVAILABLE -> 503
			throw error;
		},
		async close() {
			closeCalls += 1;
		},
	});

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "proj",
				OPENAI_API_KEY: "test-openai-key",
				VOICE_TOOLS_OPENAI_KEY: undefined,
				PI_SPEAK_OPENAI_KEY: undefined,
				ELEVENLABS_API_KEY: undefined,
				XI_API_KEY: undefined,
			},
			async () => {
				const result = await stt.transcribeAudioBuffer(Buffer.from("fake-audio"), "audio/wav");
				// Provider label stays on the selected provider even when fallback text is used.
				assert.equal(result.provider, "google");
				assert.equal(result.text, "openai fallback text");
				assert.equal(fetchCalls, 1);
				assert.equal(closeCalls, 0, "retryable Google errors keep the cached client open");
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await isolateGoogleClientCache();
	}
});

test("transcribeAudioBuffer still accepts AbortSignal as the third argument for google", async () => {
	await isolateGoogleClientCache();
	let closeCalls = 0;
	stt.testOverrides.createGoogleSpeechClient = async () => ({
		async getProjectId() {
			return "proj";
		},
		async recognize() {
			return [{ results: [{ alternatives: [{ transcript: "aborted-compatible" }] }] }];
		},
		async close() {
			closeCalls += 1;
		},
	});

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "proj",
			},
			async () => {
				const controller = new AbortController();
				const result = await stt.transcribeAudioBuffer(
					Buffer.from("fake-audio"),
					"audio/wav",
					controller.signal,
				);
				assert.equal(result.provider, "google");
				assert.equal(result.text, "aborted-compatible");
				assert.equal(closeCalls, 0, "successful Google STT keeps the cached client open");
				await stt.shutdownLocalSttWorker();
				assert.equal(closeCalls, 1, "shutdownLocalSttWorker closes the cached Google client");
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});

test("google STT reuses cached client and shutdownLocalSttWorker closes it", async () => {
	await isolateGoogleClientCache();
	let createCalls = 0;
	let closeCalls = 0;
	let recognizeCalls = 0;
	stt.testOverrides.createGoogleSpeechClient = async () => {
		createCalls += 1;
		return {
			async getProjectId() {
				return "proj";
			},
			async recognize() {
				recognizeCalls += 1;
				return [{ results: [{ alternatives: [{ transcript: `reuse-${recognizeCalls}` }] }] }];
			},
			async close() {
				closeCalls += 1;
			},
		};
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "proj",
			},
			async () => {
				const first = await stt.transcribeAudioBuffer(Buffer.from("one"), "audio/wav", {
					allowProviderFallback: false,
				});
				const second = await stt.transcribeAudioBuffer(Buffer.from("two"), "audio/wav", {
					allowProviderFallback: false,
				});
				assert.equal(first.text, "reuse-1");
				assert.equal(second.text, "reuse-2");
				assert.equal(createCalls, 1, "successful calls should reuse one cached client");
				assert.equal(closeCalls, 0, "successful calls must not close the cached channel");

				await stt.shutdownLocalSttWorker();
				assert.equal(closeCalls, 1, "shutdownLocalSttWorker should close cached Google clients");

				const third = await stt.transcribeAudioBuffer(Buffer.from("three"), "audio/wav", {
					allowProviderFallback: false,
				});
				assert.equal(third.text, "reuse-3");
				assert.equal(createCalls, 2, "after shutdown a new client should be created");
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});

test("google STT non-cancel errors keep the cached client open", async () => {
	await isolateGoogleClientCache();
	let createCalls = 0;
	let closeCalls = 0;
	stt.testOverrides.createGoogleSpeechClient = async () => {
		createCalls += 1;
		return {
			async getProjectId() {
				return "proj";
			},
			async recognize() {
				const error = new Error("boom");
				error.code = 13;
				throw error;
			},
			async close() {
				closeCalls += 1;
			},
		};
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "proj",
			},
			async () => {
				await assert.rejects(
					() =>
						stt.transcribeAudioBuffer(Buffer.from("fail"), "audio/wav", {
							allowProviderFallback: false,
						}),
					/Google transcription failed \(500\)/,
				);
				assert.equal(createCalls, 1);
				assert.equal(closeCalls, 0);
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});

test("google STT regional create args use us-central1-speech.googleapis.com", async () => {
	await isolateGoogleClientCache();
	let createArgs;
	let closeCalls = 0;
	stt.testOverrides.createGoogleSpeechClient = async (options) => {
		createArgs = options;
		return {
			async getProjectId() {
				return "proj";
			},
			async recognize() {
				return [{ results: [{ alternatives: [{ transcript: "regional" }] }] }];
			},
			async close() {
				closeCalls += 1;
			},
		};
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "proj",
				PI_SPEAK_GOOGLE_STT_LOCATION: "us-central1",
			},
			async () => {
				const result = await stt.transcribeAudioBuffer(Buffer.from("regional-audio"), "audio/wav", {
					allowProviderFallback: false,
				});
				assert.equal(result.provider, "google");
				assert.equal(result.text, "regional");
				assert.equal(createArgs.location, "us-central1");
				assert.equal(createArgs.apiEndpoint, "us-central1-speech.googleapis.com");
				assert.equal(closeCalls, 0, "successful Google STT keeps the cached client open");
				await stt.shutdownLocalSttWorker();
				assert.equal(closeCalls, 1, "shutdownLocalSttWorker closes the cached Google client");
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});

test("google STT hanging recognize aborted mid-flight closes, evicts, and recreates", async () => {
	await isolateGoogleClientCache();
	let createCalls = 0;
	let closeCalls = 0;
	let recognizeStarted = false;
	let releaseHang;
	const hang = new Promise((resolve) => {
		releaseHang = resolve;
	});

	stt.testOverrides.createGoogleSpeechClient = async () => {
		createCalls += 1;
		return {
			async getProjectId() {
				return "proj";
			},
			async recognize() {
				if (createCalls === 1) {
					recognizeStarted = true;
					await hang;
					return [{ results: [{ alternatives: [{ transcript: "should-not-win" }] }] }];
				}
				return [{ results: [{ alternatives: [{ transcript: "after-evict" }] }] }];
			},
			async close() {
				closeCalls += 1;
			},
		};
	};

	try {
		await withEnv(
			{
				PI_SPEAK_REMOTE_STT_PROVIDER: "google",
				GOOGLE_CLOUD_PROJECT: "proj",
			},
			async () => {
				const controller = new AbortController();
				const pending = stt.transcribeAudioBuffer(Buffer.from("hang"), "audio/wav", controller.signal);

				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(recognizeStarted, true);
				controller.abort();

				await assert.rejects(pending, /Transcription aborted/);
				assert.equal(closeCalls, 1, "abort should close the in-flight client");
				assert.equal(createCalls, 1);
				releaseHang();

				const result = await stt.transcribeAudioBuffer(Buffer.from("retry"), "audio/wav", {
					allowProviderFallback: false,
				});
				assert.equal(result.text, "after-evict");
				assert.equal(createCalls, 2, "abort should evict so the next call creates a fresh client");
			},
		);
	} finally {
		await isolateGoogleClientCache();
	}
});
