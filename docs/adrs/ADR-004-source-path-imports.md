# ADR-004: TS source-path imports + branded domain IDs

## Decision
1. Workspace packages are consumed as TypeScript **source** (`main: src/index.ts`) via tsconfig `paths` + esbuild/Vitest resolution. No per-package `tsc` build step, no `dist` artifacts for packages.
2. All domain IDs are branded types (`CustomerId = string & { __brand: 'CustomerId' }`).

## Reason
- Single compilation context eliminates build-order drift and stale `.d.ts` mismatch across 9 packages while the domain model churns through Stages 2–6.
- Branded IDs make cross-entity ID misuse a compile error — the cheapest possible correctness gate for a system whose whole correctness story is "the right state for the right entity."

## Tradeoffs
- Apps must bundle with a resolver that reads TS (esbuild — ADR-005); plain `node` cannot run unbundled workspace imports.
- Re-export boundaries must stay disciplined (index.ts only) to avoid cycles.

## Alternatives Considered
1. Project references + per-package emit — canonical but slow and brittle during heavy schema churn.
2. Publish to a private registry — massive overhead for a monorepo.

## Status
Accepted (2026-09-01)
