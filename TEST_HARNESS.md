# pi-speak Test Harness

Systematic test harness for the pi-speak extension, improved using agent-orchestration-improve-agent methodology.

## Baseline Metrics

| Metric | Value |
|--------|-------|
| Total Tests | 170 |
| Pass Rate | 100% |
| Baseline Duration | ~1.3s sequential / ~1.7s parallel |
| Coverage | 47.69% statements (measured with c8) |
| Stress Tests | 11 |

## Test Scripts

```bash
npm test              # Sequential run (CI default)
npm run test:parallel # Parallel execution (4 workers)
npm run test:coverage # Coverage report (text + lcov)
npm run test:stress   # Stress & adversarial suite only
npm run typecheck     # TypeScript type-only check
```

## Test Categories

1. **Golden Path** (existing) — Core feature functionality
2. **Regression** (existing) — Previously failed scenarios
3. **Edge Cases** (existing + new) — Boundary conditions, empty inputs
4. **Stress Tests** (new) — Concurrent requests, bursts, races
5. **Adversarial Inputs** (new) — Prototype pollution, path traversal, null bytes, unicode
6. **Cross-Domain** (existing) — Integration between voice, routing, UI, and server

## Failure Mode Coverage

| Category | Tests |
|----------|-------|
| Instruction misunderstanding | voice-session-command, session-routing |
| Output format errors | ui-dashboard, ui-admin-state |
| Context loss | session-events rotation, tail offsets |
| Tool misuse | control-server auth, rate limiting |
| Constraint violations | oversized body, unsupported content-type |
| Edge case handling | stress-adversarial (unicode, null bytes, deep JSON) |

## CI Pipeline

- **Type Check** — `npm run typecheck` gates before tests
- **Matrix Testing** — Ubuntu + Windows, Node 22 + 24
- **Parallel Execution** — `npm run test:parallel` for faster feedback
- **Stress Validation** — `npm run test:stress` on every PR
- **Coverage Upload** — lcov artifact retained for 30 days

## Version Management

Harness improvements follow semantic versioning tracked in this file:
- **v1.0** — Initial baseline (159 tests, no coverage)
- **v1.1** — Added ESM consistency, coverage, stress tests, parallel CI (170 tests)

## Rollback Triggers

- Test duration increases >30% from baseline
- Coverage drops >5% without documented reason
- Stress tests flaky >10% of runs

## Continuous Improvement Cycle

- **Per PR** — Run full matrix, review coverage report
- **Monthly** — Audit uncovered lines, add targeted tests
- **Quarterly** — Evaluate harness tooling upgrades (Node version, test runner features)
