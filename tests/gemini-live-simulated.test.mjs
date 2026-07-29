import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const simulated = await import("../dist/gemini-live-simulated.js");

const FAST_ENV = { PI_SPEAK_SIM_TIMESCALE: "0" };

function callbacks(messages, order) {
	return {
		onopen: () => order?.push("onopen"),
		onmessage: (message) => {
			messages.push(message);
			if (message.setupComplete) order?.push("setupComplete");
			if (message.sessionResumptionUpdate) order?.push("resumptionUpdate");
		},
	};
}

async function eventually(predicate, message = "condition was not met") {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.fail(message);
}

async function connect(env = FAST_ENV, messages = [], order) {
	const client = simulated.createSimulatedLiveClient(env);
	const session = await client.live.connect({
		model: simulated.SIMULATED_LIVE_MODEL,
		callbacks: callbacks(messages, order),
	});
	await eventually(() => messages.some((message) => message.sessionResumptionUpdate), "session resumption update was not emitted");
	return session;
}

function replyText(messages, fromIndex = 0) {
	return messages.slice(fromIndex)
		.filter((message) => typeof message.serverContent?.outputTranscription?.text === "string")
		.map((message) => message.serverContent.outputTranscription.text)
		.join("");
}

function turnCompleteCount(messages) {
	return messages.filter((message) => message.serverContent?.turnComplete).length;
}

test("connect orders onopen, resolution, setupComplete, and resumption update", async () => {
	const messages = [];
	const order = [];
	const client = simulated.createSimulatedLiveClient(FAST_ENV);
	const pending = client.live.connect({
		model: simulated.SIMULATED_LIVE_MODEL,
		callbacks: callbacks(messages, order),
	});
	const session = await pending;
	order.push("resolved");
	await eventually(() => order.includes("resumptionUpdate"));
	assert.deepEqual(order, ["onopen", "resolved", "setupComplete", "resumptionUpdate"]);
	session.close();
});

test("echo text reply streams transcription, PCM24 audio, generation completion, then turn completion", async () => {
	const messages = [];
	const session = await connect(FAST_ENV, messages);
	messages.length = 0;
	session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "hello there" }] }], turnComplete: true });
	await eventually(() => turnCompleteCount(messages) === 1, "echo reply did not complete");

	const transcription = messages.filter((message) => message.serverContent?.outputTranscription);
	assert.ok(transcription.filter((message) => "text" in message.serverContent.outputTranscription).length >= 2);
	assert.equal(replyText(messages), "You said: hello there");
	assert.equal(transcription.at(-1).serverContent.outputTranscription.finished, true);
	const audioMessages = messages.filter((message) => message.serverContent?.modelTurn?.parts?.[0]?.inlineData);
	assert.ok(audioMessages.length > 0);
	assert.ok(audioMessages.every((message) => message.serverContent.modelTurn.parts[0].inlineData.mimeType === "audio/pcm;rate=24000"));
	const generationIndex = messages.findIndex((message) => message.serverContent?.generationComplete);
	const completeIndex = messages.findIndex((message) => message.serverContent?.turnComplete);
	assert.ok(generationIndex >= 0);
	assert.ok(generationIndex < completeIndex);
	session.close();
});

test("activityStart barges into streaming audio with interrupted then turnComplete and no generationComplete", async () => {
	const messages = [];
	let session;
	const client = simulated.createSimulatedLiveClient(FAST_ENV);
	session = await client.live.connect({
		model: simulated.SIMULATED_LIVE_MODEL,
		callbacks: {
			onmessage: (message) => {
				messages.push(message);
				if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData) session.sendRealtimeInput({ activityStart: {} });
			},
		},
	});
	await eventually(() => messages.some((message) => message.sessionResumptionUpdate));
	messages.length = 0;
	session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "interrupt me" }] }], turnComplete: true });
	await eventually(() => messages.some((message) => message.serverContent?.interrupted), "interruption was not emitted");
	await new Promise((resolve) => setTimeout(resolve, 0));

	const interruptionIndex = messages.findIndex((message) => message.serverContent?.interrupted);
	const completionIndex = messages.findIndex((message) => message.serverContent?.turnComplete);
	assert.equal(completionIndex, interruptionIndex + 1);
	assert.equal(messages.filter((message) => message.serverContent?.generationComplete).length, 0);
	assert.equal(messages.filter((message) => message.serverContent?.modelTurn?.parts?.[0]?.inlineData).length, 1);
	session.close();
});

test("tool calls hold replies until their matching id and ignore wrong or duplicate responses", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-speak-sim-"));
	const scenarioPath = join(directory, "tool.json");
	writeFileSync(scenarioPath, JSON.stringify({
		turns: [{
			match: "weather",
			response: "The weather tool completed.",
			audio: false,
			toolCall: { name: "lookup_weather", args: { city: "Paris" } },
		}],
	}));
	try {
		const messages = [];
		const session = await connect({ ...FAST_ENV, PI_SPEAK_SIM_SCENARIO: scenarioPath }, messages);
		messages.length = 0;
		session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "weather please" }] }], turnComplete: true });
		await eventually(() => messages.some((message) => message.toolCall));
		const call = messages.find((message) => message.toolCall).toolCall.functionCalls[0];
		assert.equal(call.id, "sim-fc-1");
		assert.equal(call.name, "lookup_weather");
		assert.deepEqual(call.args, { city: "Paris" });
		assert.equal(messages.some((message) => message.serverContent), false);

		session.sendToolResponse({ functionResponses: { id: "wrong-id", response: {} } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.some((message) => message.serverContent), false);
		session.sendToolResponse({ functionResponses: [{ id: call.id, response: { temperature: 20 } }] });
		await eventually(() => turnCompleteCount(messages) === 1, "tool reply did not complete after matching response");
		assert.equal(replyText(messages), "The weather tool completed.");
		const countAfterCompletion = messages.length;
		session.sendToolResponse({ functionResponses: { id: call.id, response: {} } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, countAfterCompletion);
		session.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("scenario turns match in order, use fallback, and reject malformed files at connect time", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-speak-sim-"));
	const scenarioPath = join(directory, "scenario.json");
	const malformedPath = join(directory, "malformed.json");
	writeFileSync(scenarioPath, JSON.stringify({
		turns: [
			{ match: "alpha", response: "first alpha", audio: false },
			{ match: "alpha", response: "second alpha", audio: false },
		],
		fallback: { response: "fallback reply", audio: false },
	}));
	writeFileSync(malformedPath, "{ definitely not JSON");
	try {
		const messages = [];
		const session = await connect({ ...FAST_ENV, PI_SPEAK_SIM_SCENARIO: scenarioPath }, messages);
		messages.length = 0;
		for (const expected of ["first alpha", "second alpha", "fallback reply"]) {
			const fromIndex = messages.length;
			const previousCompletions = turnCompleteCount(messages);
			session.sendClientContent({ turns: [{ role: "user", parts: [{ text: expected === "fallback reply" ? "other input" : "alpha" }] }], turnComplete: true });
			await eventually(() => turnCompleteCount(messages) === previousCompletions + 1, `reply for ${expected} did not complete`);
			assert.equal(replyText(messages, fromIndex), expected);
		}
		session.close();

		const client = simulated.createSimulatedLiveClient({ ...FAST_ENV, PI_SPEAK_SIM_SCENARIO: malformedPath });
		assert.throws(() => client.live.connect({
			model: simulated.SIMULATED_LIVE_MODEL,
			callbacks: { onmessage: () => {} },
		}), /Unable to load simulated Live scenario/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("audio inactivity VAD completes an audio turn", async () => {
	const messages = [];
	const session = await connect(FAST_ENV, messages);
	messages.length = 0;
	session.sendRealtimeInput({ media: { mimeType: "audio/pcm;rate=16000", data: "AA==" } });
	assert.equal(messages.length, 0);
	await eventually(() => turnCompleteCount(messages) === 1, "silence VAD did not complete the audio turn");
	assert.equal(replyText(messages), "I heard your audio message.");
	session.close();
});

test("close cancels pending reply emissions and closes once", async () => {
	const messages = [];
	let closeCount = 0;
	const client = simulated.createSimulatedLiveClient(FAST_ENV);
	const session = await client.live.connect({
		model: simulated.SIMULATED_LIVE_MODEL,
		callbacks: {
			onmessage: (message) => messages.push(message),
			onclose: (event) => {
				closeCount += 1;
				assert.deepEqual(event, { code: 1000, reason: "simulated session closed" });
			},
		},
	});
	await eventually(() => messages.some((message) => message.sessionResumptionUpdate));
	messages.length = 0;
	session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "do not emit" }] }], turnComplete: true });
	session.close();
	session.close();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(closeCount, 1);
	assert.equal(messages.length, 0);
});

test("non-silent audio media barges into a streaming reply", async () => {
	const messages = [];
	let session;
	let sentSpeech = false;
	const client = simulated.createSimulatedLiveClient(FAST_ENV);
	session = await client.live.connect({
		model: simulated.SIMULATED_LIVE_MODEL,
		callbacks: {
			onmessage: (message) => {
				messages.push(message);
				if (!sentSpeech && message.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
					sentSpeech = true;
					const pcm = Buffer.alloc(320 * 2);
					for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(8_000, offset);
					session.sendRealtimeInput({
						media: { mimeType: "audio/pcm;rate=16000", data: pcm.toString("base64") },
					});
				}
			},
		},
	});
	await eventually(() => messages.some((message) => message.sessionResumptionUpdate));
	messages.length = 0;
	session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "interrupt on speech" }] }], turnComplete: true });
	await eventually(() => messages.some((message) => message.serverContent?.interrupted), "speech media did not interrupt");
	assert.equal(messages.some((message) => message.serverContent?.generationComplete), false);
	assert.equal(messages.filter((message) => message.serverContent?.modelTurn?.parts?.[0]?.inlineData).length, 1);
	session.close();
});

test("all-zero audio media does not interrupt a streaming reply", async () => {
	const messages = [];
	let session;
	let sentSilence = false;
	const client = simulated.createSimulatedLiveClient(FAST_ENV);
	session = await client.live.connect({
		model: simulated.SIMULATED_LIVE_MODEL,
		callbacks: {
			onmessage: (message) => {
				messages.push(message);
				if (!sentSilence && message.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
					sentSilence = true;
					session.sendRealtimeInput({
						media: {
							mimeType: "audio/pcm;rate=16000",
							data: Buffer.alloc(320 * 2).toString("base64"),
						},
					});
				}
			},
		},
	});
	await eventually(() => messages.some((message) => message.sessionResumptionUpdate));
	messages.length = 0;
	session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "ignore silence" }] }], turnComplete: true });
	await eventually(() => messages.some((message) => message.serverContent?.generationComplete), "silence stopped generation");
	assert.equal(messages.some((message) => message.serverContent?.interrupted), false);
	session.close();
});
