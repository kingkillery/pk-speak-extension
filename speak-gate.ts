import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { PiSpeakSetupConfig } from "./setup-config.js";

export type SpeakPlaybackGate = "immediate" | "enter";

export type ResolveSpeakPlaybackGateOptions = {
  readonly cliGate?: SpeakPlaybackGate;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: PiSpeakSetupConfig;
};

export type WaitForSpeakPlaybackGateOptions = {
  readonly inputStream?: typeof input;
  readonly outputStream?: typeof output;
};

export function normalizeSpeakPlaybackGate(value: string | undefined): SpeakPlaybackGate | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "":
    case undefined:
      return undefined;
    case "immediate":
    case "auto":
    case "off":
    case "none":
      return "immediate";
    case "enter":
    case "manual":
    case "key":
    case "press-enter":
      return "enter";
    default:
      return undefined;
  }
}

export function resolveSpeakPlaybackGate(options: ResolveSpeakPlaybackGateOptions = {}): SpeakPlaybackGate {
  return options.cliGate
    ?? normalizeSpeakPlaybackGate(options.env?.PI_SPEAK_PLAYBACK_GATE)
    ?? normalizeSpeakPlaybackGate(options.config?.speakPlaybackGate)
    ?? "immediate";
}

export function describeSpeakPlaybackGate(gate: SpeakPlaybackGate): string {
  switch (gate) {
    case "immediate":
      return "immediate";
    case "enter":
      return "press Enter before playback";
    default:
      return assertNever(gate);
  }
}

export async function waitForSpeakPlaybackGate(
  gate: SpeakPlaybackGate,
  options: WaitForSpeakPlaybackGateOptions = {},
): Promise<"passed" | "skipped"> {
  switch (gate) {
    case "immediate":
      return "passed";
    case "enter": {
      const inputStream = options.inputStream ?? input;
      const outputStream = options.outputStream ?? output;
      if (!inputStream.isTTY) return "skipped";
      const rl = createInterface({ input: inputStream, output: outputStream });
      try {
        await rl.question("pk-speak: press Enter to play audio...");
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
