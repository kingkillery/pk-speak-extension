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

test("live model defaults to the verified Vertex Live audio model", () => {
	assert.equal(live.getGeminiLiveModel(VERTEX_ENV), "gemini-live-2.5-flash");
	assert.equal(live.getGeminiLiveModel(DEV_ENV), "gemini-3.1-flash-live-preview");
});

test("PI_SPEAK_GEMINI_LIVE_MODEL override wins on either backend", () => {
	assert.equal(live.getGeminiLiveModel({ ...VERTEX_ENV, PI_SPEAK_GEMINI_LIVE_MODEL: "custom-x" }), "custom-x");
	assert.equal(live.getGeminiLiveModel({ ...DEV_ENV, PI_SPEAK_GEMINI_LIVE_MODEL: "custom-y" }), "custom-y");
});

test("Gemini options put the verified Vertex Live model first", () => {
	assert.equal(live.GEMINI_LIVE_MODEL_OPTIONS[0], "gemini-live-2.5-flash");
	assert.equal(live.GEMINI_TEXT_MODEL_OPTIONS[0], "gemini-3.6-flash");
	assert.ok(live.GEMINI_TEXT_MODEL_OPTIONS.includes("9router/ag/gemini-3-5-flash-high"));
	assert.ok(live.GEMINI_LIVE_MODEL_OPTIONS.includes("gemini-3.1-flash-live-preview"));
	assert.ok(live.GEMINI_LIVE_MODEL_OPTIONS.includes("gemini-live-2.5-flash-native-audio"));
	assert.deepEqual(live.GEMINI_TTS_MODEL_OPTIONS, ["gemini-3.1-flash-tts-preview"]);
});

test("current Vertex text and live models use global unless explicitly overridden", () => {
	assert.equal(live.getGeminiVertexLocation(VERTEX_ENV, "text"), "global");
	assert.equal(live.getGeminiVertexLocation(VERTEX_ENV, "live"), "global");
	assert.equal(
		live.getGeminiVertexLocation({ ...VERTEX_ENV, PI_SPEAK_VERTEX_TEXT_LOCATION: "us-east5" }, "text"),
		"us-east5",
	);
	assert.equal(
		live.getGeminiVertexLocation({ ...VERTEX_ENV, PI_SPEAK_VERTEX_LIVE_LOCATION: "europe-west4" }, "live"),
		"europe-west4",
	);
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
