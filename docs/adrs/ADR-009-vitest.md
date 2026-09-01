# ADR-009: Vitest as the test runner

## Decision
Vitest 3 (root-level config) for unit + integration + E2E suites.

## Reason
- Runs TypeScript workspace sources directly (pairs with ADR-004) — no ts-jest/babel config drift.
- First-class watch/coverage (`@vitest/coverage-v8`), `expect.each`/`it.each` for exhaustive state-machine tables.
- One runner across packages and apps keeps the Stage 9 torture suites uniform.

## Tradeoffs
- Jest ecosystem compatibility is partial; some legacy patterns don't port (acceptable — no legacy tests carry over).

## Alternatives Considered
1. Jest 29 — familiar from legacy repo; heavier TS setup, slower.

## Status
Accepted (2026-09-01)
