import { ControlServer } from "../dist/control-server.js";

const seenTurns = [];

const server = new ControlServer({
  state: {
    enabled: false,
    host: "127.0.0.1",
    port: 8767,
    authToken: "dogfood-token",
  },
  onStateChange: (patch) => {
    console.log("[state]", JSON.stringify(patch));
  },
  getStatus: () => ({
    agent: {
      provider: "pi",
      configuredProvider: "pi",
      model: "test-model",
      capabilities: {
        textTurns: true,
        voiceTurns: true,
        audioReplies: true,
        routing: true,
        steering: true,
      },
    },
    speak: { enabled: false, provider: "edge" },
    mono: { running: false },
    phone: { enabled: false },
    remote: {
      enabled: true,
      host: "127.0.0.1",
      port: 8767,
      authRequired: true,
      defaultTarget: undefined,
      currentSession: "pi",
      availableTargets: ["pi", "codex"],
    },
  }),
  getDiagnostics: () => ({
    status: {
      agent: { provider: "pi", model: "test-model" },
      speak: { enabled: false },
      mono: { running: false },
      phone: { enabled: false },
      remote: { enabled: true, host: "127.0.0.1", port: 8767, authRequired: true },
    },
    lastErrors: {},
    recentTimings: {},
    queue: {},
    providers: {},
  }),
  getRoutingStatus: () => ({
    defaultTarget: undefined,
    currentSession: "pi",
    availableTargets: ["pi", "codex"],
  }),
  setRoutingTarget: async (target) => ({
    ok: true,
    message: target ? `target:${target}` : "target:cleared",
  }),
  onMonoAction: async () => ({ ok: true, message: "mono" }),
  onSpeakAction: async () => ({ ok: true, message: "speak" }),
  onPhoneAction: async () => ({ ok: true, message: "phone" }),
  onTextTurn: async (text, includeAudio, target, cwd, mode, agentProvider) => {
    const entry = { source: "text", text, includeAudio, target, cwd, mode, agentProvider, at: new Date().toISOString() };
    seenTurns.push(entry);
    console.log("[TURN]", JSON.stringify(entry));
    return {
      replyText: `Provider was: ${agentProvider || "auto"}. You said: ${text}`,
      transcript: text,
    };
  },
  onVoiceTurn: async (_buffer, _mimeType, includeAudio, target, cwd, mode, agentProvider) => {
    const entry = { source: "voice", includeAudio, target, cwd, mode, agentProvider, at: new Date().toISOString() };
    seenTurns.push(entry);
    console.log("[TURN]", JSON.stringify(entry));
    return {
      replyText: `Provider was: ${agentProvider || "auto"} (voice)`,
      transcript: "voice transcript",
    };
  },
});

await server.start();
console.log("[dogfood-gateway] running on http://127.0.0.1:8767");
console.log("[dogfood-gateway] token: dogfood-token");
console.log("[dogfood-gateway] Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  console.log("\n[dogfood-gateway] stopping...");
  await server.stop();
  process.exit(0);
});
