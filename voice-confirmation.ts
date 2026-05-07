import { normalizeVoiceRouteKey } from "./voice-routing.js";

// Voice confirmation parser.
//
// Used by routeVoiceInput to translate "yes / no / confirm / cancel" replies
// into pending-action consume signals when the previous turn opened a
// confirmation gate (e.g. /sess remove <name>).
//
// Pickup notes:
//   - Single-word triggers stay narrow: "yes / yeah / yep / yup / ya / sure"
//     and their negatives. Avoid "ok" / "okay" / "alright" — those bleed into
//     wake variants and conversational filler.
//   - Phrase triggers ("do it", "go ahead", "scratch that") cover the common
//     spoken forms without trying to be a NLU.
//   - "stop" intentionally stays out of the negative set so it remains the
//     TTS-interrupt signal handled by isSpeechInterruptCommand.

const AFFIRMATIVE = new Set([
	"yes",
	"yeah",
	"yep",
	"yup",
	"ya",
	"sure",
	"confirm",
	"confirmed",
	"approve",
	"approved",
	"do it",
	"go ahead",
	"run it",
	"send it",
	"go for it",
]);

const NEGATIVE = new Set([
	"no",
	"nope",
	"nah",
	"cancel",
	"abort",
	"deny",
	"denied",
	"nevermind",
	"never mind",
	"forget it",
	"scratch that",
	"hold off",
]);

export function isAffirmative(text: string): boolean {
	return AFFIRMATIVE.has(normalizeVoiceRouteKey(text));
}

export function isNegative(text: string): boolean {
	return NEGATIVE.has(normalizeVoiceRouteKey(text));
}
