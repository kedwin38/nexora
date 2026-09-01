# ADR-008: Router credentials as environment-variable references

## Decision
`Router.passwordEnvVar` stores the **name** of the Railway/OS environment variable that holds the router password (e.g. `ROUTER_01_PASSWORD`). The database never stores router secrets, and the admin UI can reference/rotate-trigger without ever seeing the secret (persona §4.1).

## Reason
- Secrets belong in Railway Variables/Secrets (§40); the DB is backed up, replicated and queried far more broadly than the secret store.
- Keeps Admin Control Plane sovereignty: configuration *state* visible, secret *value* isolated.

## Tradeoffs
- Deploying a new router requires a coordinated variable addition + registry insert (documented in the Stage 4 runbook).
- A missing variable surfaces at connect time; capability checks must fail explicitly, never fall back to empty passwords.

## Alternatives Considered
1. Encrypted-at-rest column (AES-GCM with KMS key) — viable later for scale-out; adds key management now.
2. Plaintext column — rejected outright.

## Status
Accepted (2026-09-01)
