import test from "node:test";
import assert from "node:assert/strict";

const live = await import("../dist/gemini-live-turn.js");

const VERTEX_ENV = { GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us-central1" };
const DEV_ENV = { GOOGLE_API_KEY: "k" };

test("backend resolves to vertex from project+location with no API key", () => {
	assert.equal(live.getGeminiBackend(VERTEX_ENV), "vertex");
});

test("backend resolves to developer-api when only an API key is set", () => {
	assert.equal(live.getGeminiBackend(DEV_ENV), "developer-api");
});

test("explicit PI_SPEAK_GEMINI_BACKEND=vertex wins even with an API key present", () => {
	assert.equal(live.getGeminiBackend({ ...DEV_ENV, PI_SPEAK_GEMINI_BACKEND: "vertex" }), "vertex");
});

test("live model default is backend-aware (vertex half-cascade vs dev native-audio)", () => {
	assert.equal(live.getGeminiLiveModel(VERTEX_ENV), "gemini-live-2.5-flash");
	assert.equal(live.getGeminiLiveModel(DEV_ENV), "gemini-2.5-flash-native-audio-preview-12-2025");
});

test("PI_SPEAK_GEMINI_LIVE_MODEL override wins on either backend", () => {
	assert.equal(live.getGeminiLiveModel({ ...VERTEX_ENV, PI_SPEAK_GEMINI_LIVE_MODEL: "custom-x" }), "custom-x");
	assert.equal(live.getGeminiLiveModel({ ...DEV_ENV, PI_SPEAK_GEMINI_LIVE_MODEL: "custom-y" }), "custom-y");
});

test("apiVersion is backend-aware: vertex v1beta1, developer-api v1beta", () => {
	assert.equal(live.getGeminiApiVersion("vertex", {}), "v1beta1");
	assert.equal(live.getGeminiApiVersion("developer-api", {}), "v1beta");
});

test("vertex apiVersion honors PI_SPEAK_VERTEX_API_VERSION; dev ignores it", () => {
	assert.equal(live.getGeminiApiVersion("vertex", { PI_SPEAK_VERTEX_API_VERSION: "v1beta1-custom" }), "v1beta1-custom");
	// A generic v1 (correct for dev API) must NOT leak into the Vertex Live handshake.
	assert.equal(live.getGeminiApiVersion("vertex", { PI_SPEAK_GEMINI_API_VERSION: "v1" }), "v1beta1");
	assert.equal(live.getGeminiApiVersion("developer-api", { PI_SPEAK_GEMINI_API_VERSION: "v1" }), "v1");
});
