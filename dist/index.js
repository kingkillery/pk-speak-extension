"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = speakExtension;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const STATE_TYPE = "elevenlabs-speak-state";
const DEFAULT_VOICE = "adam";
const SPEECH_MODE_PROMPT = `Activate CodeChat mode for this conversation.

Speech pipeline for this session:
1. The user submits text.
2. Pi generates the full assistant response for the UI.
3. The spoken version of that response is rewritten for audio clarity through OpenRouter using model openai/gpt-oss-20b:nitro.
4. The rewritten text is then voiced through the ElevenLabs API using the ${DEFAULT_VOICE} voice.

Core behavior:
- Be highly conversational, concise, and easy to follow when heard out loud.
- Prefer short paragraphs over lists unless lists are clearly better.
- Avoid markdown tables unless I explicitly ask for one.
- Do not read or emphasize full file paths unless absolutely necessary. Prefer filenames, folder names, or short relative locations.
- Translate raw command output, stack traces, JSON, diffs, and logs into plain English first.
- When discussing code, start with the high-level purpose, then the important details, then next actions.
- Build context progressively: first explain what the repo or feature seems to do, then zoom into the relevant files and functions.
- Prefer README, docs, AGENTS.md, CLAUDE.md, specs, plans, and nearby source before going broad.
- If you need to inspect code, use tools and summarize what you found in a speech-friendly way.
- If you want to make changes, first explain the intent in one or two plain-English sentences.
- For dangerous or irreversible actions, explicitly ask for approval before proceeding.
- When the user asks follow-up questions, keep continuity and act like you are talking about the same codebase live.

Response style:
- Sound like a smart teammate talking, not a report generator.
- Keep answers tight by default and expand only when useful.
- Mention filenames and functions naturally, like “in speak11.py” or “the listen function,” instead of long path strings.
- End with the clearest next useful point or question.`;
function extractText(content) {
    if (typeof content === "string")
        return content.trim();
    if (!Array.isArray(content))
        return "";
    return content
        .filter((part) => !!part && typeof part === "object")
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
}
function getSpeakInvocation(outputPath) {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const pyScript = (0, node_path_1.join)(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.py");
    const cmdScript = (0, node_path_1.join)(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.cmd");
    const python = (0, node_fs_1.existsSync)("C:/Python314/python.exe") ? "C:/Python314/python.exe" : "python";
    if ((0, node_fs_1.existsSync)(pyScript)) {
        return { command: python, args: [pyScript, "--stdin", "-s", "-v", DEFAULT_VOICE, "-o", outputPath] };
    }
    if ((0, node_fs_1.existsSync)(cmdScript)) {
        return { command: "cmd.exe", args: ["/c", cmdScript, "--stdin", "-s", "-v", DEFAULT_VOICE, "-o", outputPath] };
    }
    return { command: "cmd.exe", args: ["/c", "speak11", "--stdin", "-s", "-v", DEFAULT_VOICE, "-o", outputPath] };
}
function getPlayerInvocation(filePath) {
    const escaped = filePath.replace(/\\/g, "\\\\");
    const ps = `
Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]::new("${escaped}"))
Start-Sleep -Milliseconds 250
$player.Play()
while ($player.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }
$duration = [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds)
Start-Sleep -Milliseconds ($duration + 1200)
$player.Stop()
$player.Close()
`;
    return { command: "powershell.exe", args: ["-NoProfile", "-Command", ps] };
}
function speakExtension(pi) {
    let enabled = false;
    let lastAssistantText = "";
    let speakingProcess;
    let playerProcess;
    let activeAudioDir;
    let phase = "ready";
    let lastCtx;
    const updateStatus = (ctx) => {
        const target = ctx || lastCtx;
        if (!target?.hasUI)
            return;
        lastCtx = target;
        if (!enabled) {
            target.ui.setStatus("speak", "");
            return;
        }
        const labels = {
            ready: "ready",
            llm: "llm",
            rewrite: "rewrite",
            voice: "elevenlabs",
            playing: "playing",
        };
        target.ui.setStatus("speak", `speak:${DEFAULT_VOICE} · ${labels[phase]}`);
    };
    const setPhase = (next, ctx) => {
        phase = next;
        updateStatus(ctx);
    };
    const persistState = () => {
        pi.appendEntry(STATE_TYPE, { enabled });
    };
    const cleanupAudioFiles = () => {
        if (activeAudioDir && (0, node_fs_1.existsSync)(activeAudioDir)) {
            try {
                (0, node_fs_1.rmSync)(activeAudioDir, { recursive: true, force: true });
            }
            catch { }
        }
        activeAudioDir = undefined;
    };
    const stopSpeaking = (ctx) => {
        if (speakingProcess && !speakingProcess.killed) {
            try {
                speakingProcess.kill();
            }
            catch { }
        }
        if (playerProcess && !playerProcess.killed) {
            try {
                playerProcess.kill();
            }
            catch { }
        }
        speakingProcess = undefined;
        playerProcess = undefined;
        cleanupAudioFiles();
        setPhase("ready", ctx);
    };
    const speakText = (text, ctx) => {
        const trimmed = text.trim();
        if (!enabled || !trimmed)
            return;
        stopSpeaking(ctx);
        setPhase("rewrite", ctx);
        activeAudioDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "pi-speak-"));
        const outputPath = (0, node_path_1.join)(activeAudioDir, "reply.mp3");
        const { command, args } = getSpeakInvocation(outputPath);
        speakingProcess = (0, node_child_process_1.spawn)(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            detached: false,
            windowsHide: true,
            shell: false,
        });
        speakingProcess.stdout?.setEncoding("utf8");
        speakingProcess.stderr?.setEncoding("utf8");
        const handleOutput = (chunk) => {
            for (const line of chunk.split(/\r?\n/)) {
                const lower = line.toLowerCase();
                if (!lower.trim())
                    continue;
                if (lower.includes("summarizing"))
                    setPhase("rewrite", ctx);
                else if (lower.includes("generating with") || lower.includes("generating"))
                    setPhase("voice", ctx);
            }
        };
        const startPlayback = () => {
            if (!(0, node_fs_1.existsSync)(outputPath)) {
                cleanupAudioFiles();
                setPhase("ready", ctx);
                return;
            }
            setPhase("playing", ctx);
            const player = getPlayerInvocation(outputPath);
            playerProcess = (0, node_child_process_1.spawn)(player.command, player.args, {
                stdio: "ignore",
                detached: false,
                windowsHide: true,
                shell: false,
            });
            playerProcess.on("exit", () => {
                playerProcess = undefined;
                cleanupAudioFiles();
                setPhase("ready", ctx);
            });
            playerProcess.on("error", () => {
                playerProcess = undefined;
                cleanupAudioFiles();
                setPhase("ready", ctx);
            });
        };
        speakingProcess.stdout?.on("data", (data) => handleOutput(String(data)));
        speakingProcess.stderr?.on("data", (data) => handleOutput(String(data)));
        speakingProcess.on("exit", (code) => {
            speakingProcess = undefined;
            if (code === 0)
                startPlayback();
            else {
                cleanupAudioFiles();
                setPhase("ready", ctx);
            }
        });
        speakingProcess.on("error", () => {
            speakingProcess = undefined;
            cleanupAudioFiles();
            setPhase("ready", ctx);
        });
        speakingProcess.stdin?.write(trimmed);
        speakingProcess.stdin?.end();
    };
    pi.registerCommand("speak", {
        description: "Enable real ElevenLabs voice mode for assistant replies",
        getArgumentCompletions: (prefix) => {
            const options = ["on", "off", "stop", "interrupt", "status", "test"];
            const matches = options.filter((opt) => opt.startsWith(prefix));
            return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
        },
        handler: async (args, ctx) => {
            lastCtx = ctx;
            const raw = args.trim();
            const lower = raw.toLowerCase();
            if (!raw || lower === "on" || lower === "enable" || lower === "start") {
                enabled = true;
                persistState();
                setPhase("ready", ctx);
                ctx.ui.notify(`Speech mode enabled (${DEFAULT_VOICE})`, "info");
                return;
            }
            if (lower === "stop" || lower === "interrupt" || lower === "quiet" || lower === "shush") {
                stopSpeaking(ctx);
                ctx.ui.notify(enabled ? "Stopped current speech playback" : "No speech playback is active", "info");
                return;
            }
            if (lower === "off" || lower === "disable") {
                enabled = false;
                persistState();
                stopSpeaking(ctx);
                updateStatus(ctx);
                ctx.ui.notify("Speech mode disabled", "info");
                return;
            }
            if (lower === "status") {
                ctx.ui.notify(enabled ? `Speech mode is on (${DEFAULT_VOICE})` : "Speech mode is off", "info");
                return;
            }
            if (lower === "test") {
                enabled = true;
                persistState();
                setPhase("rewrite", ctx);
                speakText("Hey, this is Adam using ElevenLabs through Pi speak mode.", ctx);
                ctx.ui.notify(`Played speech test with ${DEFAULT_VOICE}`, "info");
                return;
            }
            enabled = true;
            persistState();
            setPhase("ready", ctx);
            ctx.ui.notify(`Speech mode enabled (${DEFAULT_VOICE})`, "info");
            pi.sendUserMessage(raw);
        },
    });
    pi.on("session_start", async (_event, ctx) => {
        lastCtx = ctx;
        enabled = false;
        lastAssistantText = "";
        phase = "ready";
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data && typeof entry.data === "object") {
                enabled = !!entry.data.enabled;
            }
        }
        updateStatus(ctx);
    });
    pi.on("session_shutdown", async (event, ctx) => {
        lastCtx = ctx;
        stopSpeaking(ctx);
    });
    pi.on("before_agent_start", async (event, ctx) => {
        lastCtx = ctx;
        if (!enabled)
            return;
        return {
            systemPrompt: `${event.systemPrompt}\n\n${SPEECH_MODE_PROMPT}`,
        };
    });
    pi.on("agent_start", async (_event, ctx) => {
        lastCtx = ctx;
        lastAssistantText = "";
        if (enabled)
            setPhase("llm", ctx);
    });
    pi.on("message_end", async (event, ctx) => {
        lastCtx = ctx;
        if (!enabled || !event.message || event.message.role !== "assistant")
            return;
        const text = extractText(event.message.content);
        if (text)
            lastAssistantText = text;
    });
    pi.on("agent_end", async (_event, ctx) => {
        lastCtx = ctx;
        if (!enabled || !ctx.hasUI)
            return;
        if (lastAssistantText)
            speakText(lastAssistantText, ctx);
        else
            setPhase("ready", ctx);
    });
}
