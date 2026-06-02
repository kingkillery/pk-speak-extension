# Async Message Events Plan

## Summary

A small typed event bus would help `pi-speak-extension`, but it should stay narrow. The repo already has event-like pieces: durable session/admin JSONL events, an HTTP event stream, UI polling, remote turn queue callbacks, Pi lifecycle hooks, and an `AsyncQueue`. The useful change is to unify live observability and async UI updates, not to introduce a broad command bus.

## Current State

- `session-events.ts` stores session and admin events in `session-events.jsonl`.
- `control-server.ts` exposes event-stream capability over HTTP.
- `ui/hooks/useSessionStore.ts` still polls routing-store mtimes and tails the event log every 500 ms.
- `remote-turn-manager.ts` tracks queued, active, completed, and failed remote turns, but only reports changes through a callback.
- `index.ts` wires Pi lifecycle hooks such as `session_start`, `message_update`, `message_end`, `agent_end`, and `tool_call`.
- `async-queue.ts` provides an async iterable queue, but it is not currently the central messaging primitive.

## Proposed Shape

Add a small in-process `event-bus.ts` with typed publish and subscribe APIs:

```ts
export type PiSpeakEvent = {
	id: string;
	ts: number;
	kind: string;
	source: "voice" | "remote" | "command" | "admin" | "agent";
	sessionPath?: string;
	turnId?: number;
	payload: Record<string, unknown>;
};
```

Core API:

```ts
publishEvent(event: Omit<PiSpeakEvent, "id" | "ts">): PiSpeakEvent
subscribeEvents(filter?: EventFilter): AsyncIterable<PiSpeakEvent>
getRecentEvents(filter?: EventFilter): PiSpeakEvent[]
```

Keep recent events in a bounded in-memory replay buffer. Persist only durable admin/session events to JSONL; do not persist high-volume token or message deltas by default.

## Event Kinds

Initial event kinds should cover user-visible async state:

- `turn.queued`
- `turn.started`
- `turn.progress`
- `transcript.ready`
- `agent.message.delta`
- `agent.message.end`
- `tool.started`
- `tool.finished`
- `turn.completed`
- `turn.error`
- `turn.cancelled`
- `session.named`
- `session.renamed`
- `session.switched`
- `session.removed`
- `alias.added`
- `alias.removed`

## Integration Plan

1. Add `event-bus.ts` with typed events, bounded replay, and async subscription.
2. Update `session-events.ts` so durable session/admin events can also publish to the live bus.
3. Update `RemoteTurnManager` to publish turn lifecycle events instead of relying only on `onStateChange`.
4. Update `control-server.ts` event streaming to subscribe to the live bus and optionally replay recent events from an offset or cursor.
5. Keep the existing JSON HTTP responses for text and voice turns, but include event ids or turn ids so Android/PWA clients can correlate streamed progress with final responses.
6. Update the Ink session pane to consume live events where possible, while keeping file polling as a fallback for out-of-process pane launches.
7. Add focused tests for publish/subscribe ordering, replay bounds, SSE serialization, turn lifecycle event emission, and durable event bridging.

## Non-Goals

- Do not introduce a heavy framework or external message broker.
- Do not replace explicit command execution with a generic command bus.
- Do not persist every message delta or token stream by default.
- Do not remove the durable JSONL session/admin log until all pane and gateway paths have a tested replacement or fallback.

## Expected Benefits

- Android, PWA, and Ink surfaces can show live turn progress instead of waiting for final responses.
- Session routing changes and remote turn state become easier to debug.
- Cancellation and busy-state UX can be driven from typed lifecycle events.
- Existing pieces become easier to reason about because callbacks, JSONL tailing, and HTTP streaming share one event model.

## Main Risk

The main risk is over-generalizing. The event system should be treated as an observability and UI progress layer. Command routing, session mutation, and execution should stay explicit and strongly typed.
