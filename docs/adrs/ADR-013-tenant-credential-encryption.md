# ADR-013: Tenant-supplied credentials encrypted at rest (AES-256-GCM)

## Decision
Tenant (company) M-Pesa Daraja credentials — Consumer Key, Consumer Secret
and Passkey — are encrypted with **AES-256-GCM** and stored in the `Tenant`
table (`mpesa*Enc` columns). The encryption key comes from a single server
variable `CREDENTIALS_ENCRYPTION_KEY` (≥32 chars, folded to 32 bytes via
SHA-256). Ciphertext is self-describing: `v1.<iv>.<tag>.<ciphertext>`
(base64url). The API never returns plaintext — only presence booleans.

## Reason
- Router passwords use env-variable references (ADR-008) because there are
  few routers and ops controls them. That does not scale to **100+ companies
  self-onboarding**: a tenant supplies its Daraja keys at runtime through the
  UI, so the value must be stored — there is no operator to mint an env var
  per company.
- GCM gives authenticated encryption: tampering or a wrong key fails closed
  (decryption throws) rather than yielding garbage that could be sent to
  Safaricom.

## Tradeoffs
- A single master key protects all tenant credentials; rotating it requires
  re-encrypting stored ciphertext (a migration job). Acceptable for the
  current scale; a per-tenant DEK under a KMS is the scale-out path.
- If `CREDENTIALS_ENCRYPTION_KEY` is unset, companies cannot store
  credentials — the config endpoint returns `ENCRYPTION_UNAVAILABLE` rather
  than storing plaintext.

## Alternatives Considered
1. Env-variable reference per tenant (ADR-008 style) — impossible for
   self-service onboarding at scale.
2. Plaintext column — rejected outright.
3. External KMS/Vault per-tenant DEK — deferred; more infra than warranted now.

## Status
Accepted (2026-09-10)
