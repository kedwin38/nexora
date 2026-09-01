# Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|----|------|-----------|--------|------------|--------|
| KR-1 | No local PostgreSQL on dev workstation — initial migration cannot be generated locally | Certain (environment) | Medium | `prisma validate` + `prisma generate` locally; run `migrate dev`/`migrate deploy` against Railway staging; integration tests target staging or ephemeral Docker Postgres when available | OPEN |
| KR-2 | No git / no Docker on dev workstation | Certain (environment) | Low | User initializes git; Dockerfiles verified in CI/Railway build | OPEN |
| KR-3 | Railway private network cannot reach on-site MikroTik management plane | Unknown until Stage 4 | High | Adapter boundary supports both Pattern A (direct) and Pattern B (site-side connector, outbound-initiated); decide with real router network details | OPEN |
| KR-4 | BigInt JSON serialization breaks API responses | Medium | Medium | Serialization helper + contract tests before first usage endpoint ships (ADR-007) | OPEN |
| KR-5 | npm hoisting masks undeclared cross-package imports | Low | Low | Strict typecheck in each workspace; eslint import boundaries can be added if violations appear | OPEN |
| KR-6 | `deepmerge-ts < 8` high-severity advisory (GHSA-ggr8-5vv4-36mx) reachable via prisma CLI ≥ 6.13 dev tooling | Low | Low | Dev-tool-only transitive path (stack exhaustion merging recursive graphs); runtime `@prisma/client` unaffected; npm's "fix" downgrades prisma to 6.12 (breaking). Revisit when Prisma ships a fixed `@prisma/config`; re-evaluate on major upgrades | ACCEPTED |
