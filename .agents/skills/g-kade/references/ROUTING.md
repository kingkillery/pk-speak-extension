# Execution routing

Route by capability, isolation need, risk, and coordination cost.

## Route table

| Situation | Route | Review gate |
|---|---|---|
| Direct answer under a few minutes | Current agent | None |
| Focused local code/document edit | Current coding agent | Before blocked side effects |
| Broad design with uncertain constraints | Research/planning agent, then executor | Before implementation if architecture is consequential |
| Independent components | Parallel agents with exclusive ownership | At reconciliation |
| Same-file alternatives | Sequential strategy evaluation | Before choosing implementation |
| Long-running isolated work | Disposable remote workspace | Before merge/deploy |
| Desktop-only operation | Local computer-use agent | Before external or irreversible action |
| Email/calendar read | Connected tool | None unless sensitive |
| Email/calendar write | Connected tool | Explicit send/write gate |
| Personal planning | Kade-HQ triggered mode | At consequential commitment |

## Selection rules

- Use the fewest agents necessary.
- Prefer direct execution over orchestration overhead.
- Do not fan out tasks that share mutable files without a merge owner.
- Keep external writes behind an explicit gate.
- Match long-running or failure-prone work with isolated environments.
- Prefer local execution when fast feedback and existing context matter more than isolation.
- Prefer remote execution when the task is self-contained, compute-heavy, or safe to discard.

## Strategy families

When asking agents for alternatives, assign distinct strategy families, for example:

```text
minimal_patch
architecture_preserving_refactor
new_adapter_layer
operational_workaround
```

Do not ask several agents to independently produce the same generic answer.
