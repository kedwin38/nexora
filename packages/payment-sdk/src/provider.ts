/**
 * Payment provider port (M-Pesa Daraja is the first implementation — Stage 3).
 *
 * All amounts are integers in minor units (cents). Provider transaction IDs
 * are opaque strings and MUST be stored under UNIQUE(provider,
 * provider_transaction_id) — architecture map §14.
 */

export type PaymentProviderId = 'MPESA';

export interface StkPushRequest {
  /** MSISDN in international format without '+', e.g. 254712345678. */
  readonly phoneNumber: string;
  readonly amountMinor: number;
  readonly accountReference: string;
  readonly description: string;
  /** Application idempotency key (client-generated UUID). */
  readonly transactionReference: string;
}

export interface StkPushResponse {
  readonly providerTransactionId: string; // CheckoutRequestID
  readonly merchantRequestId: string;
  readonly accepted: boolean;
}

export type ProviderQueryResult =
  | { readonly status: 'SUCCESS'; readonly providerTransactionId: string; readonly receipt: string }
  | { readonly status: 'PENDING' }
  | { readonly status: 'FAILED'; readonly providerTransactionId: string; readonly reason: string };

export interface CallbackPayload {
  readonly providerTransactionId: string;
  readonly resultCode: number;
  readonly resultDesc: string;
  readonly amountMinor?: number;
  readonly receipt?: string;
  readonly sourceIp?: string;
  readonly raw: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly providerId: PaymentProviderId;

  initiateStkPush(request: StkPushRequest): Promise<StkPushResponse>;
  queryTransaction(providerTransactionId: string): Promise<ProviderQueryResult>;
  /** Parses + authenticates a raw webhook body. Must throw on invalid signatures. */
  parseCallback(rawBody: unknown, headers: Record<string, string | string[] | undefined>): Promise<CallbackPayload>;
}
