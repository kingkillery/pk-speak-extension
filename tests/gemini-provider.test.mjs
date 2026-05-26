import test from "node:test";
import assert from "node:assert/strict";

const { getGeminiBackend, isGeminiLiveConfigured } = await import("../dist/gemini-live-turn.js");

test("Gemini provider prefers Vertex AI when Google Cloud project and location are configured", () => {
	const env = {
		GOOGLE_CLOUD_PROJECT: "test-project",
		GOOGLE_CLOUD_LOCATION: "us-central1",
	};
	assert.equal(isGeminiLiveConfigured(env), true);
	assert.equal(getGeminiBackend(env), "vertex");
});

test("Gemini provider uses Developer API only when an API key is the available config", () => {
	assert.equal(isGeminiLiveConfigured({ GOOGLE_API_KEY: "test-key" }), true);
	assert.equal(getGeminiBackend({ GOOGLE_API_KEY: "test-key" }), "developer-api");
});

test("Gemini provider treats Pi Speak Vertex API key as Vertex configuration", () => {
	const env = {
		PI_SPEAK_VERTEX_API_KEY: "test-key",
	};
	assert.equal(isGeminiLiveConfigured(env), true);
	assert.equal(getGeminiBackend(env), "vertex");
});

test("Gemini provider honors explicit Vertex backend env", () => {
	const env = {
		PI_SPEAK_GEMINI_BACKEND: "vertex",
		GOOGLE_API_KEY: "test-key",
		GOOGLE_CLOUD_PROJECT: "test-project",
		GOOGLE_CLOUD_LOCATION: "us-central1",
	};
	assert.equal(getGeminiBackend(env), "vertex");
});
