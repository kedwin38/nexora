# Technical Debt Register

Every entry: impact + remediation plan + trigger.

---

## TD-001: `apps/web` dependencies not installed

- **Impact:** Web app is package.json + README only; no Next.js toolchain until Stage 7.
- **Why deliberate:** keeps Stage 1 install/typecheck fast; portal work is gated on the `/api/v1` contract anyway.
- **Remediation:** scaffold Next.js app with dark NOC design system at Stage 7 step 33–35.
- **Trigger:** Stage 7 kickoff.

## TD-002: Docker runtime stage copies full node_modules

- **Impact:** larger images than strictly needed (only `@prisma/client` + engine are required external to the bundle).
- **Remediation:** prune to `node_modules/@prisma`, `node_modules/.prisma` once bundle-only runtime is proven in CI.
- **Trigger:** first Railway image-size review.

## TD-003: AuditLog actor polymorphism not FK-enforced

- **Impact:** `actorId` may reference User or Customer depending on `actorType`; Postgres cannot enforce both.
- **Why accepted:** append-only audit semantics + typed writer layer prevent orphans; FKs would forbid system/worker actors entirely.
- **Remediation (optional later):** split into `AuditActorUser` / `AuditActorCustomer` join tables or a polymorphic FK trigger.
- **Trigger:** first audit-integrity report request.
