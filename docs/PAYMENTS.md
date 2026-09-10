# Payments — M‑Pesa (Daraja): Pay Bill & Till

NEXORA collects through Safaricom's Daraja STK Push. Each company brings its
own collection account and API credentials, so money flows directly to the
company. Both **Pay Bill** and **Till (Buy Goods)** are supported.

## 1. Pay Bill vs. Till

| | Pay Bill | Till (Buy Goods) |
|---|---|---|
| Daraja `TransactionType` | `CustomerPayBillOnline` | `CustomerBuyGoodsOnline` |
| `BusinessShortCode` | your paybill number | your **store/HO** number |
| `PartyB` (credited) | the paybill number | the **till** number |
| Account reference | meaningful | ignored by Safaricom |

In NEXORA you just pick **PAYBILL** or **TILL** and supply the numbers; the
correct Daraja fields are sent for you. For a till, if the till number equals
the store number you may leave *Party B* blank and it defaults to the
shortcode.

## 2. Get your Daraja credentials

1. Create/log into the [Safaricom Developer Portal](https://developer.safaricom.co.ke/).
2. Create an app to obtain a **Consumer Key** and **Consumer Secret**.
3. For STK Push you need a **Passkey** (sandbox passkey is published; for
   production it is issued with your Lipa na M‑Pesa Online shortcode).
4. Note your **shortcode** (paybill) or **store + till** (Buy Goods).

## 3. Configure a company

**Admin → Settings → Payments** (or `PUT /api/v1/admin/tenant/payment-config`):

```json
{
  "channel": "TILL",
  "env": "production",
  "shortcode": "5678900",
  "partyB": "5678901",
  "consumerKey": "…",
  "consumerSecret": "…",
  "passkey": "…"
}
```

Credentials are encrypted at rest with AES‑256‑GCM under the server's
`CREDENTIALS_ENCRYPTION_KEY` (ADR‑013). The API never returns them — only
presence booleans. Rotating a credential is a single field update.

> The server must have `CREDENTIALS_ENCRYPTION_KEY` set (≥32 chars) before a
> company can save credentials. Without it the endpoint returns
> `ENCRYPTION_UNAVAILABLE`.

## 4. Callback URL

Set `PUBLIC_BASE_URL` on the server; NEXORA uses
`${PUBLIC_BASE_URL}/api/v1/webhooks/mpesa` as the STK callback. Callbacks are
bound to the `CheckoutRequestID` NEXORA itself initiated — a forged receipt
for an un-initiated payment is rejected, and the amount is re-verified.

## 5. Lifecycle — every payment reaches a terminal state

A payment is never left hanging. It always ends in exactly one of:

| Status | Meaning | How it's reached |
|---|---|---|
| `SUCCESS` | Paid; service activated | Callback `ResultCode 0`, or reconciliation query |
| `CANCELLED` | Customer declined the prompt | Callback `ResultCode 1032` |
| `EXPIRED` | Timed out / never completed | Timeout codes (1037/1019/…), or the reconciliation sweep past the deadline, or an STK that never reached Safaricom |
| `FAILED` | Hard rejection | Other codes (wrong PIN, insufficient funds, …) |

**Closing the loop:** on initiation a payment gets a `deadlineAt`. The
scheduler enqueues `payment-reconciliation` every 2 minutes; the worker
queries stale payments against the provider, activates the paid ones, and
closes out the rest — cancelled, failed, or expired. Customers receive an
SMS for each outcome.

## 6. Local development

Set `PAYMENT_PROVIDER=mock` to use the deterministic in‑process provider (no
phone needed). `dev:stack` can auto-confirm mock payments after a short delay
via `MOCK_PAYMENT_AUTO_CONFIRM_MS`. Production must never auto-confirm.
