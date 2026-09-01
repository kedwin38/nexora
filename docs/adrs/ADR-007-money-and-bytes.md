# ADR-007: Integer money (minor units) and BigInt byte counters

## Decision
- Money: integers in **minor units** (`priceMinor`, `amountMinor`), currency ISO code alongside. No floats, no Decimal — ever.
- Data/byte counters: Prisma `BigInt` columns (`usedBytes`, `downloadBytes`).

## Reason
- M-Pesa amounts are exact integers; minor units make arithmetic and reconciliation lossless.
- Byte counters routinely exceed 2^31 and can exceed 2^53 on aggregation → BigInt is the only safe PG integer type.

## Tradeoffs
- JSON serialization of `bigint` throws by default; every API boundary must stringify explicitly. A serialization helper + contract tests guard this in Stage 7.
- Prisma BigInt requires `BigInt` casts in queries — verbose but explicit.

## Alternatives Considered
1. Float money — categorically rejected (rounding drift in a billing system).
2. Decimal columns — heavier than needed when the minor unit is 1 (KES cents rarely used in hotspot pricing; still exact).

## Status
Accepted (2026-09-01)
