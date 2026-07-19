# Context precedence and conflict handling

Use the following order when instructions or evidence conflict:

1. Current explicit user request and decisions
2. Safety and irreversible-action boundaries
3. Repository-local instructions within their scope
4. Current session state and confirmed project decisions
5. Applicable Kade-HQ stable preferences
6. Verified durable memory with source and freshness metadata
7. Skill defaults
8. Agent assumptions

## Rules

- A lower-ranked source must not silently override a higher-ranked source.
- Repository-local instructions control implementation details only within that repository.
- A current explicit instruction can temporarily override a stable preference without rewriting permanent memory.
- An assumption is never promoted to fact merely because it was useful.
- When two sources at the same level conflict, preserve both, identify the conflict, and stop only if it materially changes the result.
- For stale or time-sensitive facts, retrieve current evidence before execution.

## Context packet discipline

Every nontrivial packet should label:

```yaml
facts:
assumptions:
instructions:
preferences:
constraints:
unresolved_conflicts:
source_map:
```

A source map entry should include:

```yaml
id:
source:
recorded_at:
scope:
freshness:
```

Do not send entire notebooks, memory stores, or human profiles downstream when a smaller excerpt is sufficient.
