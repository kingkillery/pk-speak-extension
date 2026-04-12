# Edge Case Trace — pi-speak-extension

Traced against commit `20460a2` (post-hardening).

---

## 1. Double Start — `/mono on` twice quickly

**Verdict: OK**

**Code path**:
- `/mono on` → `handler` (index.ts) → `startListener(ctx)`
- Guard: `if (listenerProcess) return;` (index.ts, `startListener`)

**Trace**:
1. First call enters `startListener`. `listenerProcess` is `undefined`, passes guard.
2. `spawn()` returns synchronously — `listenerProcess` is assigned immediately, even before the Python process has started or connected stdout.
3. Second call enters `startListener`, sees `listenerProcess` is truthy, returns early.

**Why it's safe**: JavaScript is single-threaded. `spawn()` synchronously returns a `ChildProcess` object. There is no window between the guard check and the assignment where a second invocation could sneak through. The readline interface (`createInterface`) is created on the synchronously-available `stdout` stream and will buffer events until the Python side starts writing.

---

## 2. Session Switch While Speaking

**Verdict: RISK**

**Code path**:
1. Voice transcription yields "switch to session X"
2. `handleListenerEvent` → `routeVoiceInput` → detects `"switch to session "` prefix
3. Calls `pi.sendUserMessage('/session switch X')`
4. `/session` handler → `ctx.switchSession(sessionPath)`
5. Framework fires `session_shutdown` → `session_start`

**Trace**:
- `session_shutdown` (index.ts): calls `stopSpeaking(ctx)` ✓ and `stopListener(ctx)` — kills the **listener** process.
- `session_start` (index.ts): iterates new session's branch. If the new session has a persisted `MONO_STATE_TYPE` entry with `listening: true`, calls `startListener(ctx)`.

**Identified risk**:
The listener process **kills itself as a side effect of the session switch it initiated**. Whether it restarts depends entirely on whether the *target* session has a persisted `MonoState` entry. If session B was created outside voice mode, it has no such entry → the listener stays dead after the switch. The user must manually `/mono on` again.

**Speech handling**: `stopSpeaking` in `session_shutdown` correctly kills both `speakingProcess` and `playerProcess`, cleans up temp audio files, and resets phase to `ready`. **This part is fine.**

---

## 3. Listener Dies Unexpectedly

**Verdict: OK**

**Code path** (Python crashes, e.g., no microphone):
- `listener.py` `main()` → `sd.RawInputStream(...)` throws → `emit("error", ...)` → `sys.exit(1)`
- Node `exit` handler on `listenerProcess` fires

**Trace**:
```typescript
// index.ts — listenerProcess exit handler
listenerProcess.on("exit", (code) => {
    listenerProcess = undefined;   // allows re-start
    monoActive = false;
    voiceInputActive = false;
    updateMonoStatus(ctx);
    // notifies user if non-zero exit
});
```

- `listenerProcess = undefined` → clears the guard so `startListener` can be called again.
- `monoActive = false`, `voiceInputActive = false` → status reflects reality.
- User error notification shown for non-zero exit.
- `/mono on` will work again because the guard variable is cleared.

**Note**: `listenerRl` is not explicitly closed in the `exit` handler (only `stopListener` does that), but it's overwritten on next `startListener` call and the old readline's underlying stream is dead, so no stale events fire. Acceptable.

---

## 4. Voice Command While Agent Is Streaming

**Verdict: RISK**

**Code path**:
1. Agent is running → `agent_start` has fired, `phase = "llm"`, `lastAssistantText = ""`
2. Listener transcribes speech → `handleListenerEvent` → `routeVoiceInput(text)` → `pi.sendUserMessage(text)`
3. Behavior depends on what `sendUserMessage` does during an active agent turn (framework-level, outside extension control)

**Trace of the extension's side**:
- `routeVoiceInput` has **no guard** checking whether the agent is currently running. It calls `pi.sendUserMessage(text)` unconditionally.
- If the framework interrupts the agent: `agent_end` fires. If `message_end` captured a partial response into `lastAssistantText`, the extension will TTS-speak a **partial/truncated** response.
- If the framework queues the message: the current agent finishes normally, speaks the full response, then processes the new message. This is fine.
- The `deliverAs` option is **not used anywhere** in this extension — all `sendUserMessage` calls are plain text.

**Identified risk**: No defensive measure to prevent sending messages during an active agent turn. Worst case: partial response gets spoken aloud if the framework interrupts the agent.

---

## 5. Session Registry Across Sessions

**Verdict: RISK**

**Code path**:
- Session A: `/session name foo` → `sessionRegistry["foo"] = sessionFile` → `persistSessionRegistry()` → `pi.appendEntry(SESSION_REGISTRY_TYPE, { sessions: sessionRegistry })` appends to **session A's branch only**.
- Session B: `session_start` fires → iterates `ctx.sessionManager.getBranch()` of B → finds no registry entries in B's branch.

**Trace**:
1. In-memory `sessionRegistry` is **never reset** on `session_start`. It's only merged into:
   ```typescript
   sessionRegistry = { ...sessionRegistry, ...reg.sessions };
   ```
2. So during a single extension process lifetime, the registry survives session switches via the in-memory variable.
3. **However**: on extension/process restart, only the *current* session's branch is read. Entries persisted exclusively in other sessions' branches are lost.

**Identified risk**:
- If user is in session A, names it "foo", switches to session B, and then the extension process restarts → loading session B finds no registry → "foo" is lost.
- `persistSessionRegistry()` snapshots the *entire* registry to the *current* session's branch. So whichever session you're in when you last call `/session name ...` gets the full snapshot. Other sessions become stale.
- This is a **data loss risk** after restart if the last-active session wasn't the one with the most recent registry snapshot.

---

## 6. Rapid Wake On/Off

**Verdict: OK** (minor theoretical risk)

**Code path** (in `listener.py`):
1. Vosk recognizes "pi mono on" → `on_wake_on()` → `active = True`, emit wake
2. Audio chunks flow; `run_vosk_detector` loop may start collecting for whisper
3. Vosk recognizes "pi mono off" → `on_wake_off()` → `active = False`
4. Immediately after: `collecting_for_whisper = False; whisper_buffer.clear()`

**Trace**:
- The `run_vosk_detector` loop is **single-threaded**. Both wake detection and whisper collection happen in the same loop iteration.
- The `audio_callback` (sounddevice thread) only puts data into `audio_queue`. It never reads `active`.
- `active` is set in the vosk loop thread (via `on_wake_on`/`on_wake_off` closures called from the same loop). No cross-thread race on `active`.
- When wake-off is detected, the whisper buffer is explicitly cleared and collecting is disabled.

**Minor theoretical risk**: If the `flush_to_whisper()` call fires (via the 2-second silence timeout check) *between* wake-on and wake-off recognition, a chunk gets pushed to `transcription_queue`. But given that "pi mono on" + "pi mono off" takes at least ~3-4 seconds for Vosk to recognize both phrases, and the silence timeout is 2 seconds, this would require a very specific pause pattern. Even if it happens, the worst outcome is one stale transcription event being emitted after voice mode is deactivated — the Node side would receive a `speech` event while `voiceInputActive` has already been set to `false` by the `wake off` event. But `routeVoiceInput` is still called because `handleListenerEvent` doesn't check `voiceInputActive` before routing speech:

```typescript
case "speech":
    updateMonoStatus(target);
    if (event.text) {
        routeVoiceInput(event.text, target);  // no voiceInputActive guard!
    }
    break;
```

This means a stale transcription *would* be routed as a user message even though voice mode is off. **Minor bug** but very unlikely to trigger.

---

## 7. Whisper Worker Backpressure

**Verdict: RISK**

**Code path** (in `listener.py`):
- Audio collected into `whisper_buffer` (bytearray) while user is speaking.
- On 2-second silence: `flush_to_whisper()` → `transcription_queue.put(bytes(whisper_buffer))`
- `whisper_worker` thread: `transcription_queue.get()` → `transcribe_audio(audio_bytes)`

**Trace**:

1. **`whisper_buffer` growth**: During continuous speech (no 2-second pause), the buffer grows linearly. 30 seconds of 16kHz 16-bit mono = ~960KB. Tolerable but unbounded — a 5-minute monologue = ~9.6MB.

2. **`transcription_queue` growth**: `queue.Queue()` has no `maxsize` (unbounded). If the user produces speech segments faster than whisper can transcribe them, the queue grows without limit. With the "tiny" model on CPU, transcription of a 10-second segment might take 3-5 seconds. If the user produces a new segment every 3 seconds (2s speech + 1s pause), the queue grows by one item every ~3 seconds while the worker only processes one every ~3-5 seconds. **Gradual unbounded growth**.

3. **No backpressure mechanism**: No queue size limit, no dropping of old segments, no warning when the queue is deep. There is exactly one worker thread — no parallelism for transcription.

**Practical impact**: For typical conversational use (short sentences with pauses), the queue stays near-empty. For sustained rapid speech (dictation, reading aloud), the queue grows and transcriptions arrive increasingly delayed. Memory usage increases but doesn't crash — it's audio bytes, not huge structures.

---

## Summary Table

| # | Scenario | Verdict | Key Issue |
|---|----------|---------|-----------|
| 1 | Double start | **OK** | `spawn()` is synchronous; JS single-thread prevents race |
| 2 | Session switch while speaking | **RISK** | Listener kills itself; restart depends on target session's persisted state |
| 3 | Listener dies unexpectedly | **OK** | Clean state reset; restart via `/mono on` works |
| 4 | Voice command while agent streaming | **RISK** | No guard against sending during active agent; partial response may be spoken |
| 5 | Session registry across sessions | **RISK** | In-memory survives but persisted registry is per-branch; lost on restart |
| 6 | Rapid wake on/off | **OK** | Single-threaded Vosk loop; minor: stale speech event could route after deactivation |
| 7 | Whisper backpressure | **RISK** | Unbounded queue and buffer; no limit, no drop, single worker thread |
