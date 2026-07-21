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
		return await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function openAiEnv(extra = {}) {
	return {
		PI_SPEAK_REMOTE_STT_BACKEND: "existing",
		PI_SPEAK_REMOTE_STT_PROVIDER: "openai",
		OPENAI_API_KEY: "test-openai-key",
		VOICE_TOOLS_OPENAI_KEY: undefined,
		PI_SPEAK_OPENAI_KEY: undefined,
		ELEVENLABS_API_KEY: undefined,
		XI_API_KEY: undefined,
		PI_SPEAK_STT_TELEMETRY: "off",
		...extra,
	};
}

function resetOverrides() {
	stt.testOverrides.transcribeWithMoonshine = null;
	stt.testOverrides.onSttTelemetry = null;
}

test.afterEach(async () => {
	resetOverrides();
	await stt.shutdownLocalSttWorker();
});

test("existing backend remains the default", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ text: "existing backend" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
	try {
		await withEnv(openAiEnv({ PI_SPEAK_REMOTE_STT_BACKEND: undefined }), async () => {
			assert.equal(stt.resolveSttBackendMode(), "existing");
			const result = await stt.transcribeAudioBuffer(Buffer.from("audio"), "audio/wav");
			assert.equal(result.provider, "openai");
			assert.equal(result.selectedBackend, "existing");
			assert.equal(result.text, "existing backend");
			assert.deepEqual(result.attempts.map((attempt) => attempt.backend), ["existing"]);
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Moonshine can be selected explicitly", async () => {
	let calls = 0;
	stt.testOverrides.transcribeWithMoonshine = async () => {
		calls += 1;
		return "hello world";
	};
	await withEnv(openAiEnv({ PI_SPEAK_REMOTE_STT_BACKEND: "moonshine" }), async () => {
		const result = await stt.transcribeAudioBuffer(Buffer.from("audio"), "audio/wav");
		assert.equal(result.provider, "moonshine");
		assert.equal(result.selectedBackend, "moonshine");
		assert.equal(result.text, "hello world");
		assert.equal(calls, 1);
	});
});

test("auto keeps the existing backend while healthy, including an empty transcript", async () => {
	const originalFetch = globalThis.fetch;
	let moonshineCalls = 0;
	stt.testOverrides.transcribeWithMoonshine = async () => {
		moonshineCalls += 1;
		return "fallback";
	};
	try {
		for (const text of ["primary healthy", ""]) {
			globalThis.fetch = async () => new Response(JSON.stringify({ text }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
			await withEnv(openAiEnv({ PI_SPEAK_REMOTE_STT_BACKEND: "auto" }), async () => {
				const result = await stt.transcribeAudioBuffer(Buffer.from("audio"), "audio/wav");
				assert.equal(result.provider, "openai");
				assert.equal(result.selectedBackend, "existing");
				assert.equal(result.text, text);
			});
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(moonshineCalls, 0);
});

test("auto activates Moonshine once for a typed transport failure", async () => {
	const originalFetch = globalThis.fetch;
	const telemetry = [];
	let moonshineCalls = 0;
	globalThis.fetch = async () => {
		const error = new Error("socket closed");
		error.code = "ECONNRESET";
		throw error;
	};
	stt.testOverrides.transcribeWithMoonshine = async () => {
		moonshineCalls += 1;
		return "fallback transcript";
	};
	try {
		await withEnv(openAiEnv({ PI_SPEAK_REMOTE_STT_BACKEND: "auto" }), async () => {
			const result = await stt.transcribeAudioBuffer(Buffer.from("audio"), "audio/wav", {
				onTelemetry: (event) => telemetry.push(event),
			});
			assert.equal(result.provider, "moonshine");
			assert.deepEqual(result.fallback, { from: "existing", to: "moonshine", code: "transport_unavailable" });
			assert.equal(result.text, "fallback transcript");
			assert.equal(moonshineCalls, 1);
			assert.deepEqual(result.attempts.map((attempt) => attempt.outcome), ["failed", "success"]);
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(telemetry.map((event) => [event.type, event.code]), [
		["primary_failure", "transport_unavailable"],
		["fallback_activated", "transport_unavailable"],
	]);
});

test("auto does not fallback for invalid audio, configuration, abort, or unknown failures", async () => {
	for (const error of [
		new Error("OpenAI transcription failed (400)"),
		new Error("OPENAI_API_KEY is required for OpenAI STT"),
		new Error("Transcription aborted"),
		new Error("unexpected programmer error"),
	]) {
		assert.equal(stt.shouldFallbackToMoonshine(error), false, error.message);
	}
	assert.equal(stt.classifySttFailure(new Error("OpenAI transcription failed (400)")), "invalid_audio");
	assert.equal(stt.classifySttFailure(new Error("OPENAI_API_KEY is required for OpenAI STT")), "configuration");
});

test("fallback classification accepts only recognized transient or unavailable failures", () => {
	assert.equal(stt.shouldFallbackToMoonshine(new Error("OpenAI transcription failed (429)")), true);
	assert.equal(stt.shouldFallbackToMoonshine(new Error("Google transcription failed (503)")), true);
	const network = new Error("network");
	network.code = "ENOTFOUND";
	assert.equal(stt.shouldFallbackToMoonshine(network), true);
	const wrapped = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
	assert.equal(stt.shouldFallbackToMoonshine(wrapped), true);
	assert.equal(stt.shouldFallbackToMoonshine(new Error("Local STT worker exited (1)")), true);
});

test("disabling provider fallback also disables cross-backend fallback", async () => {
	const originalFetch = globalThis.fetch;
	let moonshineCalls = 0;
	globalThis.fetch = async () => {
		const error = new Error("network");
		error.code = "ECONNRESET";
		throw error;
	};
	stt.testOverrides.transcribeWithMoonshine = async () => {
		moonshineCalls += 1;
		return "unexpected";
	};
	try {
		await withEnv(openAiEnv({ PI_SPEAK_REMOTE_STT_BACKEND: "auto" }), async () => {
			await assert.rejects(
				() => stt.transcribeAudioBuffer(Buffer.from("audio"), "audio/wav", { allowProviderFallback: false }),
				/ECONNRESET|network/,
			);
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(moonshineCalls, 0);
});

test("both backends failing preserves both causes and diagnostics", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		const error = new Error("primary unavailable");
		error.code = "ENOTFOUND";
		throw error;
	};
	stt.testOverrides.transcribeWithMoonshine = async () => {
		throw new Error("Moonshine inference failed");
	};
	try {
		await withEnv(openAiEnv({ PI_SPEAK_REMOTE_STT_BACKEND: "auto" }), async () => {
			await assert.rejects(
				() => stt.transcribeAudioBuffer(Buffer.from("audio"), "audio/wav"),
				(error) => {
					assert.ok(error instanceof AggregateError);
					assert.equal(error.errors.length, 2);
					assert.match(error.message, /primary unavailable/);
					assert.match(error.message, /Moonshine inference failed/);
					return true;
				},
			);
			const diagnostics = stt.getSttDiagnostics();
			assert.equal(diagnostics.lastAttempt.requestedBackend, "auto");
			assert.deepEqual(diagnostics.lastAttempt.attempts.map((attempt) => attempt.backend), ["existing", "moonshine"]);
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Moonshine worker reports a missing dependency or model without silently using existing STT", async () => {
	await withEnv({
		PI_SPEAK_REMOTE_STT_BACKEND: "moonshine",
		PI_SPEAK_MOONSHINE_MODEL_PATH: "Z:/definitely-missing-moonshine-model",
		PI_SPEAK_STT_TELEMETRY: "off",
	}, async () => {
		await assert.rejects(
			() => stt.transcribeAudioBuffer(Buffer.from("RIFF"), "audio/wav"),
			/Moonshine|model path|moonshine_voice/i,
		);
	});
});

test("invalid backend and legacy provider configurations fail loudly", async () => {
	await withEnv({ PI_SPEAK_REMOTE_STT_BACKEND: "mystery" }, async () => {
		assert.throws(() => stt.resolveSttBackendMode(), /Expected existing, moonshine, or auto/);
	});
	await withEnv({ PI_SPEAK_REMOTE_STT_PROVIDER: "moonshine" }, async () => {
		assert.throws(() => stt.resolveSttProvider(), /PI_SPEAK_REMOTE_STT_BACKEND=moonshine/);
	});
});
