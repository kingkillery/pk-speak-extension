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
    console.log("[state change]", JSON.stringify(patch));
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
    speak: { enabled: false },
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
    const entry = { source: "text", text, includeAudio, target, cwd, mode, agentProvider };
    seenTurns.push(entry);
    console.log("[text turn]", JSON.stringify(entry));
    return {
      replyText: `Received: text="${text}" provider=${agentProvider || "auto"}`,
      transcript: text,
    };
  },
  onVoiceTurn: async (_buffer, _mimeType, includeAudio, target, cwd, mode, agentProvider) => {
    const entry = { source: "voice", includeAudio, target, cwd, mode, agentProvider };
    seenTurns.push(entry);
    console.log("[voice turn]", JSON.stringify(entry));
    return {
      replyText: `Received: voice provider=${agentProvider || "auto"}`,
      transcript: "voice transcript",
    };
  },
});

await server.start();
console.log("[dogfood] ControlServer listening on", server.getRuntimeState().port);

// Self-test: verify provider overrides propagate correctly
async function selfTest() {
  const baseUrl = `http://127.0.0.1:8767`;
  const auth = { Authorization: "Bearer dogfood-token" };

  // Test 1: POST text turn with codex override
  {
    const res = await fetch(`${baseUrl}/v1/turn/text`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello codex", audio: false, agentProvider: "codex" }),
    });
    const data = await res.json();
    console.log("[test 1 POST codex] status:", res.status, "reply:", data.replyText);
  }

  // Test 2: GET text turn with pi override
  {
    const res = await fetch(`${baseUrl}/v1/turn/text?text=hello+pi&audio=0&agentProvider=pi`, {
      headers: auth,
    });
    const data = await res.json();
    console.log("[test 2 GET pi] status:", res.status, "reply:", data.replyText);
  }

  // Test 3: POST voice turn with codex override
  {
    const res = await fetch(`${baseUrl}/v1/turn/voice?audio=0&agentProvider=codex`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "audio/wav" },
      body: Buffer.from("fake-wav-data"),
    });
    const data = await res.json();
    console.log("[test 3 voice codex] status:", res.status, "reply:", data.replyText);
  }

  // Test 4: POST text turn with auto (no override)
  {
    const res = await fetch(`${baseUrl}/v1/turn/text`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello auto", audio: false }),
    });
    const data = await res.json();
    console.log("[test 4 auto] status:", res.status, "reply:", data.replyText);
  }

  // Test 5: status reflects agent provider
  {
    const res = await fetch(`${baseUrl}/v1/status`, { headers: auth });
    const data = await res.json();
    console.log("[test 5 status] status:", res.status, "agent:", data.status?.agent?.provider);
  }

  // Verify all turns captured the right provider
  console.log("\n[summary] captured turns:");
  for (const t of seenTurns) {
    console.log(`  ${t.source}: provider=${t.agentProvider || "undefined(auto)"}`);
  }

  const allCorrect =
    seenTurns[0]?.agentProvider === "codex" &&
    seenTurns[1]?.agentProvider === "pi" &&
    seenTurns[2]?.agentProvider === "codex" &&
    seenTurns[3]?.agentProvider === undefined;

  if (allCorrect) {
    console.log("\n[dogfood] PASS: all provider overrides propagated correctly.");
  } else {
    console.log("\n[dogfood] FAIL: provider override mismatch.");
    process.exitCode = 1;
  }

  await server.stop();
  console.log("[dogfood] server stopped.");
}

setTimeout(() => selfTest().catch((e) => { console.error(e); process.exit(1); }), 500);
