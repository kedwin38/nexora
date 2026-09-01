# ADR-006: Argon2id password hashing

## Decision
Hash all human passwords (staff `User`, registered `Customer`) with Argon2id via `@node-rs/argon2` (default params: memoryCost 19456 KiB, timeCost 2, parallelism 1 — OWASP baseline).

## Reason
Architecture map §39 mandates "a modern password-hashing algorithm such as Argon2id". Argon2id is the PHC winner and the current OWASP first choice. `@node-rs/argon2` ships prebuilt binaries for linux x64/arm64 and Windows, avoiding node-gyp in CI/Docker builds.

## Tradeoffs
- Native module (N-API prebuilt) — if a platform binary were missing we'd fall back to the pure-JS `argon2` wrapper or `hash-wasm` (decision at implementation time, Stage 2).

## Alternatives Considered
1. bcrypt (legacy repo used bcryptjs-10) — memory-hardness weaker, 72-byte truncation.
2. scrypt — acceptable but slower to tune and less standard in identity tooling.

## Status
Accepted (2026-09-01) — implementation lands in Stage 2.
