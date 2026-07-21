import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { PiSpeakSetupConfig } from "./setup-config.js";

/**
 * Speech playback gates.
 *
 * - "immediate": legacy auto-play. Audio plays the moment synthesis finishes.
 *   Kept opt-in for scripts/CI that want fire-and-forget TTS.
 * - "enter": synthesize, then block on stdin until the operator presses Enter.
 *   Non-TTY stdin skips playback entirely (file left on disk).
 * - "orb": the new default. Synthesize, stage the artifact at the gateway,
 *   open the desktop orb in `mode=speech` with pause/stop/disable controls.
 *   Audio NEVER auto-plays. On any staging/orb failure the file is left on
 *   disk with a clear error — there is no autoplay fallback.
 */
export type SpeakPlaybackGate = "immediate" | "enter" | "orb";

export type ResolveSpeakPlaybackGateOptions = {
  readonly cliGate?: SpeakPlaybackGate;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: PiSpeakSetupConfig;
};

export type WaitForSpeakPlaybackGateOptions = {
  readonly inputStream?: typeof input;
  readonly outputStream?: typeof output;
  readonly signal?: AbortSignal;
};

export function normalizeSpeakPlaybackGate(value: string | undefined): SpeakPlaybackGate | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "":
    case undefined:
      return undefined;
    case "immediate":
    case "auto":
      return "immediate";
    case "enter":
    case "manual":
    case "key":
    case "press-enter":
      return "enter";
    case "orb":
    case "ui":
    case "interactive":
      return "orb";
    case "off":
    case "none":
      // Preserved for backwards compatibility: explicitly means "immediate"
      // (the original auto-play semantics) so existing configs/scripts that
      // set PI_SPEAK_PLAYBACK_GATE=off keep working unchanged.
      return "immediate";
    default:
      return undefined;
  }
}

export function resolveSpeakPlaybackGate(options: ResolveSpeakPlaybackGateOptions = {}): SpeakPlaybackGate {
  return options.cliGate
    ?? normalizeSpeakPlaybackGate(options.env?.PI_SPEAK_PLAYBACK_GATE)
    ?? normalizeSpeakPlaybackGate(options.config?.speakPlaybackGate)
    ?? "orb";
}

export function describeSpeakPlaybackGate(gate: SpeakPlaybackGate): string {
  switch (gate) {
    case "immediate":
      return "immediate";
    case "enter":
      return "press Enter before playback";
    case "orb":
      return "open interactive orb (no autoplay)";
    default:
      return assertNever(gate);
  }
}

export async function waitForSpeakPlaybackGate(
  gate: SpeakPlaybackGate,
  options: WaitForSpeakPlaybackGateOptions = {},
): Promise<"passed" | "skipped"> {
  options.signal?.throwIfAborted();
  switch (gate) {
    case "immediate":
    case "orb":
      // orb never blocks stdin — the control surface is the orb window, not
      // the terminal. Immediate is a no-op pass so the caller proceeds to
      // its own playback path.
      return "passed";
    case "enter": {
      const inputStream = options.inputStream ?? input;
      const outputStream = options.outputStream ?? output;
      if (!inputStream.isTTY) return "skipped";
      const rl = createInterface({ input: inputStream, output: outputStream });
      try {
        await rl.question("pk-speak: press Enter to play audio...", { signal: options.signal });
        options.signal?.throwIfAborted();
        return "passed";
      } finally {
        rl.close();
      }
    }
    default:
      return assertNever(gate);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled speak playback gate: ${value}`);
}
