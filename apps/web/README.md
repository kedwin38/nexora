# @nexora/web

NEXORA web frontends (Stage 7 of the build order):

- **Customer portal** — dashboard: status, package, usage, FUP, expiry, sessions.
- **Guest portal** — package selection, phone entry, payment, temporary identity, service status.
- **Admin command center** — NOC dashboard per the Interface Aesthetic Directive
  (dark, terminal-inspired, high-density, monospace data values) with
  Business State / Desired Network State / Actual Network State separation and
  drift visualization.

The web app talks **only** to the API over `/api/v1`; it never touches
PostgreSQL and never holds router credentials (architecture map §6.1).

Next.js dependencies are intentionally not installed during Stage 1 — see
`docs/technical-debt.md` TD-001.
