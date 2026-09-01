# ADR-010: pino for structured logging

## Decision
pino 9 behind a small wrapper (`@nexora/logging`): JSON lines in prod, pino-pretty in dev, secret redaction at the serializer level, service + correlation bindings.

## Reason
- Fastest structured logger in the Node ecosystem; Railway log drains get parseable JSON by default.
- Built-in `redact` enforces the "secrets never logged" invariant mechanically (§78) rather than by convention.

## Tradeoffs
- Wrapper hides pino's child-logger type; acceptable given the tiny Logger interface we expose.

## Alternatives Considered
1. winston (legacy repo) — heavier, slower, redaction by manual sanitizers (which the legacy audit showed drifting).

## Status
Accepted (2026-09-01)
