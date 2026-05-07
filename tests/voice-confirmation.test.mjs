import test from "node:test";
import assert from "node:assert/strict";
import { isAffirmative, isNegative } from "../dist/voice-confirmation.js";

test("affirmatives recognise canonical single-word forms", () => {
	for (const phrase of ["yes", "yeah", "yep", "yup", "ya", "sure", "confirm", "confirmed", "approve", "approved"]) {
		assert.equal(isAffirmative(phrase), true, `expected "${phrase}" to be affirmative`);
	}
});

test("affirmatives recognise canonical phrase forms", () => {
	for (const phrase of ["do it", "go ahead", "run it", "send it", "go for it"]) {
		assert.equal(isAffirmative(phrase), true, `expected "${phrase}" to be affirmative`);
	}
});

test("negatives recognise canonical forms", () => {
	for (const phrase of ["no", "nope", "nah", "cancel", "abort", "deny", "denied", "nevermind", "never mind", "forget it", "scratch that", "hold off"]) {
		assert.equal(isNegative(phrase), true, `expected "${phrase}" to be negative`);
	}
});

test("affirmatives ignore conversational filler that begins with yes-like words", () => {
	for (const phrase of ["", "yes please run the build", "yeah but later", "sure thing boss"]) {
		assert.equal(isAffirmative(phrase), false, `expected "${phrase}" not to be affirmative`);
	}
});

test("negatives ignore conversational filler that contains no-like words", () => {
	for (const phrase of ["", "no problem run it", "nope keep going", "nevermind that go ahead"]) {
		assert.equal(isNegative(phrase), false, `expected "${phrase}" not to be negative`);
	}
});

test("ok and okay are intentionally NOT affirmatives", () => {
	// They overlap with wake variants ("okay PK") and conversational filler.
	// Only canonical confirmation words are accepted.
	for (const phrase of ["ok", "okay", "alright"]) {
		assert.equal(isAffirmative(phrase), false, `expected "${phrase}" not to be treated as confirmation`);
	}
});

test("stop is intentionally NOT a negative", () => {
	// "stop" is reserved for isSpeechInterruptCommand (cuts TTS playback).
	assert.equal(isNegative("stop"), false);
});

test("affirmative and negative are mutually exclusive", () => {
	const samples = ["yes", "no", "confirm", "cancel", "do it", "nevermind"];
	for (const phrase of samples) {
		const a = isAffirmative(phrase);
		const n = isNegative(phrase);
		assert.notEqual(a, n, `"${phrase}" matched both lists`);
	}
});

test("normalization handles punctuation and case", () => {
	assert.equal(isAffirmative("YES."), true);
	assert.equal(isAffirmative("Confirm!"), true);
	assert.equal(isNegative("Never Mind."), true);
	assert.equal(isNegative("CANCEL"), true);
});
