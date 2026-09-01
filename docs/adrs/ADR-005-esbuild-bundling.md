# ADR-005: esbuild bundling for app services

## Decision
Each app builds to a single **CommonJS** bundle via esbuild (`apps/*/dist/index.cjs`), with `@prisma/client` and `.prisma` kept external.

## Reason
- Consumes workspace packages as TS source (ADR-004) with zero config.
- Produces a deterministic single-file artifact per Railway service; `node dist/index.cjs` is the entire runtime surface.
- Prisma stays external because its query engine binary must be resolved from node_modules, not inlined.
- CJS output (not ESM): Fastify/avvio are CommonJS and issue dynamic `require()` calls, which break inside an ESM bundle without shims; `.cjs` extension sidesteps the app package's `"type": "module"` (verified by Stage 1 boot smoke test).

## Tradeoffs
- No dead-code granularity across package boundaries; bundles include unused exports reachable from the entry graph (acceptable at current size).
- Debugging uses bundled line numbers unless source maps are shipped (they are: `--sourcemap` can be added when first needed — not yet emitted).

## Alternatives Considered
1. tsc emit + node_modules shipping — requires package builds first (rejected in ADR-004).
2. tsx in production — dev tool in prod; higher startup cost, larger runtime dep graph.

## Status
Accepted (2026-09-01)
