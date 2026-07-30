# Secure Mesh Context Design

**Status:** proposal — not implemented
**Decision:** OptMem is **not** the canonical shared-memory system. It is permitted only as an optional, device-local materialized recall cache after a separate authenticated mesh protocol accepts a checkpoint.

## Scope and non-goals

This design carries small, deliberately curated operational context between trusted Pi Speak devices and agents: durable decisions, handoff instructions, active task state, and explicitly approved status facts. It does **not** replicate prompts, raw transcripts, workspace files, tool output, credentials, or session logs.

The canonical system must support authenticated incremental checkpoints across devices, deterministic replay/convergence, revocation, recovery, and bounded retention. It must remain compatible with the existing OMP Hub publish/resume flow in `hub-handoff.ts` without treating that snapshot link as an incremental event stream or authorization system.

Out of scope for the first delivery:

- raw multi-writer file synchronization;
- direct synchronization of OptMem's `MEMORY_DIR`, `LOG.txt`, `TREE/`, or lock file;
- general document collaboration or source-code replication;
- automatic publication of conversational context; and
- exposing decrypted checkpoint content to the relay, browser clients, logs, or speech output by default.

## Why OptMem is not the shared journal

OptMem's local append log assigns positional record identity and serializes writers using a local advisory lock. It provides neither replica identity, signed events, distributed conflict resolution, remote authorization, transport, replay defense, nor cryptographic key management. A cloud-drive or Git sync of two disconnected logs can make both devices assign the same positional record and has no defined merge semantics for the log or its mutable summary tree.

Therefore:

1. **Never synchronize OptMem storage files between devices.**
2. **Never use an OptMem offset as a mesh cursor, checkpoint ID, or authority proof.**
3. A single local materializer may write a compact, policy-approved projection of already accepted mesh events into a private OptMem directory.
4. The materializer must record canonical event IDs separately so duplicate delivery cannot create duplicate local notes. `TREE/` is disposable cache and can be rebuilt locally.

An ignored or compiled-only local mesh artifact is not an implementation foundation. A source-backed, reviewed protocol and its tests are required before this feature is shipped.

## Identity and provenance — preserve the distinctions

The protocol keeps physical device, gateway/provider, agent/session, route alias, and operation role separate. No user-facing label is silently promoted into a stable identity.

| Concept | Stable protocol field | Meaning | Must not be used as |
| --- | --- | --- | --- |
| Device | `producer.deviceId` | Enrolled device public-key identity, for example the device named `mac2` | A route alias or provider name |
| Gateway/runtime | `producer.gatewayId`, `producer.gatewayKind` | The authenticated gateway/runtime instance, such as a Mac2 Hermes Agent Cloud deployment | A device key or session ID |
| Provider/model | `producer.provider`, `producer.model` | The backend that generated or applied context, such as `hermes` | The gateway identity |
| Agent instance | `producer.agentId` | Immutable instance/lane identifier when the runtime provides one | A friendly route name |
| Session | `sessionId` | Stable session identifier or canonical session path hash | A compact route family |
| Compact route | `routeAlias` | Optional UI provenance only, such as `PK1` / family `1` | An agent, device, or authorization identity |
| Handoff actor | `actor.role = "handoff-bot"` | A protocol actor that requested or relayed a handoff, if one exists in the integrating runtime | A gateway, provider, or agent identity |
| Handoff action | `operation = "hub_publish" | "hub_resume"` | The operation performed by the existing owner-serialized Hub bridge | A persistent bot or session identity |

`PK1` is deliberately excluded from identity and authorization. The existing `/sess` contract defines `one`, `1`, and `PK1` as the mutable compact route family `1`; remapping that family must not join or overwrite the history of a Mac2 Hermes Agent Cloud agent. The same rule keeps a Handoff bot's operation trace separate from the agent context it transports.

The current checked implementation exposes Hub publish/resume operations, not a discovered, stable "Handoff bot" identity. An adapter may emit the distinct `handoff-bot` role only after the runtime can authenticate and identify that actor. Until then, handoff events record `actor.role = "system"` plus the authenticated gateway and operation, never an invented bot ID.

## Canonical checkpoint model

The relay stores opaque encrypted envelopes. Recipients validate and apply a typed plaintext checkpoint only after authentication and authorization. The event identifier is a random immutable UUID or 256-bit value; it is never derived from time, local log position, route alias, or a hub URL.

```ts
type MeshCheckpoint = {
  schemaVersion: 1;
  eventId: string;
  workspaceId: string;              // stable opaque workspace identity
  scope: "workspace" | "session" | "agent";
  sessionId?: string;
  producer: {
    deviceId: string;
    gatewayId: string;
    gatewayKind: string;
    provider?: string;
    model?: string;
    agentId?: string;
  };
  routeAlias?: { family: "1" | "2"; observedName: string };
  actor: { role: "agent" | "desktop" | "phone" | "system" | "handoff-bot" };
  operation?: "checkpoint" | "hub_publish" | "hub_resume";
  deviceSequence: number;           // strictly increasing for producer.deviceId
  parents: string[];                // bounded causal predecessors
  kind: "decision" | "task-state" | "handoff" | "target-state";
  payload: {
    summary: string;                // bounded, policy-approved
    facts: Record<string, string | number | boolean | null>;
  };
  classification: "internal" | "private";
  retention: { expiresAt: string; supersedes?: string[] };
  createdAt: string;
};
```

Before an event is encrypted, the publisher validates:

- schema version, kind, scope, producer fields, maximum byte length, and bounded parent count;
- an allowlist of payload fields per event kind;
- a ban on raw prompt/transcript, tool-output, source-file, credential, token, private-key, cookie, and unredacted absolute-path fields;
- secret-shaped content detection and redaction/rejection; and
- the current workspace/agent capability and data-classification policy.

Natural-language redaction is fallible. For that reason the allowlist and default ban on transcript-like fields are primary controls; scanning is defense in depth, not proof of safety.

## Cryptographic envelope and authorization

Each enrolled device owns a signing key held by the platform key store. Its current public key, device ID, workspace capabilities, and key epoch are distributed through an authenticated enrollment mechanism. The exact algorithms may be selected during implementation, but the envelope must provide modern authenticated encryption, detached sender authentication, and versioned key/algorithm identifiers.

The authenticated associated data binds at least:

```text
schemaVersion, eventId, workspaceId, scope, sessionId,
senderDeviceId, senderKeyId, deviceSequence, parents,
recipientKeyEpoch, capabilityId, payloadHash
```

The sender signs the canonical metadata plus payload hash, then encrypts the bounded payload for the authorized recipients. The relay can index only the minimum opaque routing metadata and ciphertext. It must not receive plaintext facts or a reusable Hub URL fragment.

A receiving device rejects an event before applying it unless all of the following hold:

1. The envelope and schema versions are supported and size limits pass.
2. The sender key is enrolled, unrevoked, and authorized for the requested workspace/scope at the capability epoch.
3. The signature, authenticated-encryption tag, recipient/key epoch, and associated data validate.
4. The event ID is new, the per-device sequence is within the replay window, and predecessors/cursor satisfy the declared causal rule.
5. Decrypted content passes the current schema, classification, and secret/content policy.

The relay is an authenticated, blind append/fetch service. Possession of a Hub link, a local device pairing token, a `PK1` alias, or a cloud-folder credential is not authority to publish, fetch, or decrypt a checkpoint.

## Replication, convergence, and recovery

### Append and fetch

1. The local publisher creates a validated event and envelope.
2. The relay accepts only an enrolled sender with a valid capability and stores the opaque envelope under a monotonic relay cursor.
3. The sender receives a durable receipt. Local state records the event ID, device sequence, and acknowledged relay cursor.
4. Receivers fetch after their persisted cursor, verify every envelope locally, and atomically store the applied event ID plus updated cursor before acknowledging.
5. At-least-once delivery is safe because an already applied `eventId` is a no-op.

A device keeps a per-device sequence and a set/index of applied IDs in the canonical local mesh store. It must never use a file length, a local sequence from another device, or an OptMem note number as the global cursor.

### Conflict policy

Event kinds declare merge behavior instead of relying on arrival time:

| Event kind | Merge rule |
| --- | --- |
| `decision` | Append-only; a later decision may explicitly list superseded IDs. |
| `task-state` | Compare causal parents first, then `deviceSequence`, then a deterministic device-ID tie break. Preserve losing concurrent update for audit. |
| `target-state` | Do not alter active routing solely from mesh delivery. Present conflicting target state for local/operator resolution. |
| `handoff` | Append-only audit/state marker. It never impersonates the handoff actor or changes session ownership. |

Security, approval, revocation, and destructive-state conflicts require explicit operator resolution; they must not be auto-merged.

### Hub bootstrap and existing handoff

`hub-handoff.ts` remains responsible only for owner-idle, owner-local `/hub publish` and `/hub resume` session-snapshot operations. It is not replaced by OptMem and is not a multi-writer mesh log. Its present resume path restores Hub entries into a local session fork; it does **not** establish a mesh cursor, authorization epoch, or a guarantee that the snapshot excludes transcript material.

The mesh protocol therefore adds a **separate signed, recipient-encrypted bootstrap manifest**. It is not embedded in, inferred from, or authenticated merely by the Hub URL. The manifest binds:

```text
workspaceId, optional sessionId, snapshot digest/reference,
mesh relay cursor, sender device/key ID, recipient/key epoch,
capability/ACL epoch, issued/expiry time, and schema version
```

For a newly enrolled or recovered device:

1. Authenticate pairing/enrollment and install the current workspace authorization/key epoch.
2. Verify and decrypt the separate bootstrap manifest against the enrolled sender, workspace, recipient, and current capability epoch.
3. If the operator elected to recover the OMP session, run the existing encrypted Hub snapshot flow independently and bind its received snapshot digest to the manifest. Treat the resulting fork as a session recovery artifact, not curated mesh context.
4. Install the manifest's authenticated mesh cursor and fetch/verify incremental checkpoint envelopes after that cursor.
5. Allow publishing only after the manifest, local cursor state, and any elected snapshot binding are installed.

A mismatched, stale, expired, or substituted manifest/snapshot fails closed. Existing busy, queued-work, ownership, and parallel-handoff protections remain in force. Curated mesh recovery is usable without importing an OMP session snapshot; any transcript-bearing Hub payload remains optional and independently governed.

## Optional local OptMem projection

After acceptance, a single local worker may transform an approved event into a short private OptMem note. The note contains no ciphertext key, Hub URL secret, raw payload, raw path, transcript, or rejected event. The worker keeps a separate mapping such as `{ eventId, optmemNoteId, materializedAt }` and runs exactly once per accepted event.

Deleting the local OptMem tree or rebuilding a device must not change canonical mesh state. Rebuilding the local projection reads verified canonical events again; it never imports or synchronizes an OptMem log from another device.

## Delivery gates and acceptance tests

### Gate 0 — policy and provenance

Deliver the versioned schema, per-kind field allowlists, retention rules, threat model, conflict rules, and identity mappings above.

Accept only when tests prove that raw transcripts, secrets, source snippets, and absolute paths are rejected/redacted; `PK1` changes cannot change `deviceId`, `gatewayId`, `agentId`, or session identity; and a Handoff bot operation remains distinct from Mac2 Hermes Agent Cloud provenance.

### Gate 1 — enrollment, crypto, and ACLs

Deliver device enrollment, OS-keystore keys, key epochs, signed capabilities, revocation, rotation, and a bounded envelope parser.

Accept only when altered ciphertext/AAD, forged sender, revoked key, stale capability epoch, replay, unknown schema, and oversized envelope all fail closed without logging plaintext or Hub fragments.

### Gate 2 — canonical relay and local apply journal

Deliver the opaque append/fetch service, persistent cursors/applied-ID set, per-device sequences, atomic apply/ack, and audit metadata.

Accept only when two offline devices converge under reorder/retry/partition recovery, duplicates apply once, a crash between receive and acknowledgment is safe, and concurrent `task-state` events follow the documented rule.

### Gate 3 — Hub-adjacent bootstrap integration

Deliver the separately signed, recipient-encrypted bootstrap manifest and its cursor/key/capability-epoch binding. Integrate it with the existing serialized Hub publish/resume path only as an **optional** session-recovery companion.

Accept only when a device can recover curated context without importing an OMP snapshot; an elected snapshot is digest-bound to the manifest but remains independently classified as potentially transcript-bearing; and stale/substituted/mismatched manifest or snapshot attempts are rejected while existing Hub handoff tests remain green.

### Gate 4 — optional OptMem materializer

Deliver the one-way local materializer and rebuild procedure only after Gates 0–3 pass.

Accept only when deleting/corrupting local OptMem cache does not affect canonical state, repeated canonical events produce one note, and no OptMem filesystem content ever crosses devices.

### Gate 5 — operational validation

Deliver multi-device integration tests, non-sensitive security telemetry, key rotation/revocation and lost-device procedures, and a retention audit.

Accept only when all adversarial cases pass and a real desktop/phone recovery demonstrates authenticated baseline plus incremental curated checkpoints.

## Residual risks

An authorized compromised device can decrypt its permitted context. The protocol therefore minimizes data, scopes capabilities tightly, supports revocation/key rotation, uses OS-level device protection, and retains only bounded curated facts. Encryption does not make raw transcripts safe to replicate, and a redaction classifier cannot guarantee that arbitrary free text is harmless. Metadata such as timing, workspace routing, and payload sizes also needs minimization.
