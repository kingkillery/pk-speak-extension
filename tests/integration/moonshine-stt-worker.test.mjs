import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { transcribeAudioBuffer, shutdownLocalSttWorker } from "../../dist/stt.js";

const enabled = process.env.PI_SPEAK_RUN_MOONSHINE_INTEGRATION === "1";

test("Moonshine worker transcribes a pre-provisioned deterministic speech fixture", { skip: !enabled }, async () => {
	const fixture = process.env.PI_SPEAK_MOONSHINE_FIXTURE?.trim();
	assert.ok(fixture, "PI_SPEAK_MOONSHINE_FIXTURE must point to a local deterministic speech fixture");
	const expected = process.env.PI_SPEAK_MOONSHINE_EXPECTED_TEXT?.trim().toLowerCase();
	assert.ok(expected, "PI_SPEAK_MOONSHINE_EXPECTED_TEXT must provide the expected transcript when integration is enabled");
	const previousBackend = process.env.PI_SPEAK_REMOTE_STT_BACKEND;
	try {
		process.env.PI_SPEAK_REMOTE_STT_BACKEND = "moonshine";
		const audio = await readFile(resolve(fixture));
		const result = await transcribeAudioBuffer(audio, "audio/wav", { allowProviderFallback: false });
		assert.equal(result.provider, "moonshine");
		assert.equal(result.selectedBackend, "moonshine");
		assert.ok(result.text.trim(), "Moonshine returned an empty transcript for the speech fixture");
		assert.match(result.text.toLowerCase(), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally {
		if (previousBackend === undefined) delete process.env.PI_SPEAK_REMOTE_STT_BACKEND;
		else process.env.PI_SPEAK_REMOTE_STT_BACKEND = previousBackend;
		await shutdownLocalSttWorker();
	}
});
