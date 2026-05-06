# Output Contract

For strict operational turns, respond in this shape:

Task type: <ingest|query|lint|skill|schema|other>

Stack/config used:
- <config path or defaults>

Files read:
- <path>
- <path>

Files changed:
- <path>
- <path>

What changed:
- <concise bullets>

Unresolved questions / conflicts:
- <if any>

Next best actions:
- <1-3 concrete next steps>

Reducer packet (required for long-running or multi-step tasks):
- Route decision: <complete|retry_same_worker|reroute_to_sibling|escalate_to_parent|stop_insufficient_evidence>
- Route reason: <short reason>
- Artifact refs:
  - <brief/validation/delta/packet refs>
- Unresolved questions:
  - <if any>
