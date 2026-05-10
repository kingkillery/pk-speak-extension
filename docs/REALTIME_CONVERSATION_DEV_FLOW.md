# Realtime Conversation Dev Flow

## Working Thesis

The target is not a realtime model that directly codes. The target is a realtime conversational layer that understands the operator, filters noisy speech into useful intent, chooses the right context, and submits high-quality prompts or action plans to coding agents.

In short:

```text
conversation -> reducer -> clean task/action steps -> execution router -> coding agent/tooling
```

Bad, neutral, repeated, or corrected speech should be dropped or archived, not blindly forwarded into the coding agent.

## End Dream

The ideal flow is a natural back-and-forth conversation with an AI partner that is aware of the repo, active work, logs, screen/audio context, and pending reminders.

The voice agent should be able to:

- keep up with a realtime spoken conversation
- understand when the user is thinking out loud versus giving an instruction
- ask clarifying questions before dispatching risky work
- find repo context when it needs more information
- summarize the actionable task cleanly
- choose what should be executed now versus saved for later
- hand a focused prompt to Codex, Claude Code, Pi, Kimi, or another coding backend
- report back with useful status and next steps

The coding agent should receive a distilled task, not a raw transcript.

## Architecture

### 1. Realtime Conversation Layer

Primary responsibility: natural interaction.

Potential providers:

- ElevenLabs realtime/agent voice
- Gemini Live
- future OpenAI realtime model

This layer should handle:

- low-latency speech in and speech out
- interruption/barge-in
- conversational state
- lightweight clarification
- speaking progress updates back to the user

It should not directly mutate the repo or execute arbitrary commands.

### 2. Conversation Reducer

Primary responsibility: turn noisy conversation into structured intent.

The reducer should extract:

- `goal`
- `constraints`
- `current repo or session target`
- `actionable task`
- `acceptance criteria`
- `known context`
- `unknowns`
- `explicitly rejected ideas`
- `deferred reminders`
- `risk level`

The reducer should discard:

- filler
- repeated phrasing
- abandoned ideas
- emotional noise
- corrected instructions
- low-confidence speculation

The reducer is the main safety boundary between casual speech and actual coding work.

### 3. Execution Router

Primary responsibility: choose the right execution backend.

Possible targets:

- Codex for repo edits and tests
- Claude Code for alternate implementation passes
- Pi coding agent for existing Pi workflows
- shell commands for narrow verification
- wiki/memory tools for durable notes
- reminder/task storage for deferred follow-up

The router should decide:

- whether to execute now
- whether more context is needed
- which coding backend is best
- what files or subsystem are relevant
- whether the task is too risky without confirmation

### 4. Evidence And Memory Layer

Primary responsibility: keep an audit trail without polluting working context.

Desired stored artifacts:

- screen recording
- audio recording
- transcript
- reduced task summaries
- accepted and rejected action steps
- prompts sent to coding agents
- tool outputs
- code diffs
- test results
- follow-up reminders

The raw recording should exist as an in-case archive. The agent should mostly work from derived structured records, not replay the full recording into every prompt.

### 5. Feedback Loop

Primary responsibility: keep the user oriented.

The realtime voice agent should say things like:

- "I am turning that into a Codex task."
- "I am holding that as a reminder."
- "I am ignoring the first version because you corrected it."
- "I need one clarification before I dispatch this."
- "The coding agent finished. The tests passed."

The user should not have to inspect logs to know what happened.

## Near-Term Implementation Path

### Phase 1: Polish The Current Turn-Based Loop

Use the existing Android/browser gateway flow:

- mobile records speech
- gateway receives `/v1/turn/voice`
- gateway transcribes and runs the agent
- gateway returns `replyText` and `audioUrl`
- phone plays the response

Provider stack:

- ElevenLabs primary for reply audio
- Gemini Live as alternate/fallback
- existing Pi/Codex/Gemini text backends for execution

Goal: make this reliable, understandable, and fast before adding full realtime complexity.

### Phase 2: Add A Conversation Reducer Endpoint

Add an endpoint that accepts recent transcript/chat context and returns a structured task packet.

Example output:

```json
{
  "goal": "Wire ElevenLabs as the primary mobile voice provider.",
  "actionableTask": "Update the gateway provider selection so Android voice turns receive ElevenLabs audio replies without exposing keys to the app.",
  "constraints": [
    "Keep API keys server-side",
    "Do not change the mobile API contract",
    "Use Gemini Live as fallback"
  ],
  "rejectedIdeas": [
    "Put ElevenLabs keys in Android"
  ],
  "needsConfirmation": false
}
```

### Phase 3: Add Optional Realtime Mode

Realtime mode should connect the mobile app to the gateway, not directly to provider APIs.

Expected shape:

```text
Android mic -> gateway realtime session -> ElevenLabs/Gemini Live -> reducer/router -> coding backend
```

This keeps provider keys off-device and lets the gateway enforce auth, logging, rate limits, and context filtering.

### Phase 4: Add Recording And Audit Trail

Add opt-in screen/audio recording storage as an audit archive.

The archive should be searchable through a tool, but ordinary agent work should use summarized records.

Open questions:

- where recordings live
- retention period
- whether to encrypt locally
- how to redact secrets
- how to link recordings to agent actions
- how to replay a session safely

## Design Principles

- The realtime model is the interface and triage layer, not the final coder.
- The coding agent receives distilled prompts, not raw conversation.
- Provider keys stay server-side.
- Raw recordings are archive material, not default prompt context.
- The user should be able to interrupt, correct, and redirect naturally.
- The system should preserve decisions and reminders without preserving every spoken word as active context.
- Execution should be gated by confidence and risk.

## Unresolved Questions

- What is the minimum reducer schema that is useful without becoming bureaucratic?
- Should realtime mode be always-on while tray is running, or only while the mobile app has an active session?
- Which actions require explicit confirmation?
- How should the system decide between Codex, Claude Code, Pi, and other coding agents?
- What should be saved to durable wiki memory versus short-term session memory?
- How much repo context should the realtime layer know directly versus retrieving on demand?
- What latency is acceptable before the experience stops feeling conversational?

## Current Recommendation

Do not jump straight to full realtime coding control.

First, ship the polished turn-based conversational mobile loop with ElevenLabs primary and Gemini Live alternate. Then add the reducer. After that, realtime voice becomes much safer because the live model will talk to a structured planning layer instead of directly driving the coding backend.
