# ADR-001: npm workspaces as the monorepo tool

## Decision
Use npm workspaces (root `package.json` with `apps/*` and `packages/*`). No pnpm, no Turborepo initially.

## Reason
The dev workstation and CI targets have only npm (Node 24 / npm 11). pnpm is not installed and adding corepack/turbo adds toolchain risk without current benefit — the task graph is small (typecheck/lint/test/build fan out in ~1 min).

## Tradeoffs
- Slower installs than pnpm; single shared node_modules hoist can mask undeclared deps (mitigated by strict typecheck + lint).
- No remote/build caching until Turborepo is added.

## Alternatives Considered
1. pnpm workspaces — faster, stricter phantom-dep detection; requires tool not present on this machine.
2. Turborepo on top of npm — pipeline caching; deferred until build times justify it (tracked in technical-debt if needed).

## Status
Accepted (2026-09-01)
