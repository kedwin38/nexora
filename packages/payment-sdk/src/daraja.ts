/**
 * M-Pesa Daraja STK Push provider (Stage 3).
 *
 * Endpoints (sandbox | production):
 *   OAuth:    /oauth/v1/generate?grant_type=client_credentials
 *   STK Push: /mpesa/stkpush/v1/processrequest
 *   Query:    /mpesa/stkpushquery/v1/query
 *
 * Note on callback authenticity: Daraja STK callbacks carry no signature
 * header (IP allowlisting is documented for C2B only). We bind results to
 * CheckoutRequestIDs we ourselves initiated — an attacker cannot forge a
 * receipt for a payment they did not start. Amount is re-verified against
 * the stored payment. See ADR-012.
 */

import { randomUUID } from 'node:crypto';
import type {
  CallbackPayload,
  PaymentProvider,
  ProviderQueryResult,
  StkPushRequest,
  StkPushResponse,
} from './provider.js';

export interface DarajaConfig {
  readonly env: 'sandbox' | 'production';
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly shortcode: string;
  readonly passkey: string;
  readonly callbackUrl: string;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

interface StkCallbackBody {
  readonly Body?: {
    readonly stkCallback?: {
      readonly MerchantRequestID?: string;
      readonly CheckoutRequestID?: string;
      readonly ResultCode?: number;
      readonly ResultDesc?: string;
      readonly CallbackMetadata?: { readonly Item?: Array<{ Name: string; Value?: unknown }> };
    };
  };
}

export function darajaTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function darajaPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

/** Pure extraction of a Daraja STK callback into our CallbackPayload. */
export function parseStkCallback(raw: unknown): CallbackPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = (raw as StkCallbackBody).Body?.stkCallback;
  if (body === undefined || typeof body.CheckoutRequestID !== 'string') return null;

  const items = body.CallbackMetadata?.Item ?? [];
  const find = (name: string): string | number | undefined => {
    const item = items.find((i) => i.Name === name);
    return item?.Value as string | number | undefined;
  };

  const amount = find('Amount');
  const receipt = find('MpesaReceiptNumber');

  return {
    providerTransactionId: body.CheckoutRequestID,
    resultCode: typeof body.ResultCode === 'number' ? body.ResultCode : -1,
    resultDesc: body.ResultDesc ?? '',
    ...(typeof amount === 'number' || typeof amount === 'string' ? { amountMinor: Number(amount) * 100 } : {}),
    ...(typeof receipt === 'string' && receipt.length > 0 ? { receipt } : {}),
    raw: raw as Record<string, unknown>,
  };
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class MpesaDarajaProvider implements PaymentProvider {
  public readonly providerId = 'MPESA' as const;
  private readonly config: DarajaConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private tokenCache: TokenCache | null = null;

  constructor(config: DarajaConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? ((): Date => new Date());
  }

  private get baseUrl(): string {
    return this.config.env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';
  }

  private async accessToken(): Promise<string> {
    if (this.tokenCache !== null && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }
    const auth = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString('base64');
    const response = await this.fetchImpl(`${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok) {
      throw new Error(`Daraja OAuth failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as { access_token: string; expires_in: string };
    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in) * 1000,
    };
    return data.access_token;
  }

  public async initiateStkPush(request: StkPushRequest): Promise<StkPushResponse> {
    const timestamp = darajaTimestamp(this.now());
    const password = darajaPassword(this.config.shortcode, this.config.passkey, timestamp);
    const response = await this.fetchImpl(`${this.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: this.config.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(request.amountMinor / 100),
        PartyA: request.phoneNumber,
        PartyB: this.config.shortcode,
        PhoneNumber: request.phoneNumber,
        CallBackURL: this.config.callbackUrl,
        AccountReference: request.accountReference.slice(0, 12),
        TransactionDesc: request.description.slice(0, 20),
      }),
    });
    const data = (await response.json()) as {
      CheckoutRequestID?: string;
      MerchantRequestID?: string;
      ResponseCode?: string;
      ResponseDescription?: string;
    };
    if (!response.ok || data.ResponseCode !== '0' || data.CheckoutRequestID === undefined) {
      throw new Error(`Daraja STK push failed: ${data.ResponseDescription ?? `HTTP ${response.status}`}`);
    }
    return {
      providerTransactionId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID ?? '',
      accepted: true,
    };
  }

  public async queryTransaction(providerTransactionId: string): Promise<ProviderQueryResult> {
    const timestamp = darajaTimestamp(this.now());
    const response = await this.fetchImpl(`${this.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: this.config.shortcode,
        Password: darajaPassword(this.config.shortcode, this.config.passkey, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: providerTransactionId,
      }),
    });
    const data = (await response.json()) as { ResultCode?: string; ResultDesc?: string };
    if (data.ResultCode === '0') {
      return { status: 'SUCCESS', providerTransactionId, receipt: providerTransactionId };
    }
    if (data.ResultCode === '1032' || data.ResultCode === '1037') {
      return { status: 'PENDING' };
    }
    return {
      status: 'FAILED',
      providerTransactionId,
      reason: data.ResultDesc ?? `ResultCode ${data.ResultCode ?? 'unknown'}`,
    };
  }

  public async parseCallback(
    rawBody: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<CallbackPayload> {
    const payload = parseStkCallback(rawBody);
    if (payload === null) {
      throw new Error('Unparseable Daraja STK callback body');
    }
    return payload;
  }
}

/**
 * Deterministic in-process provider for local development and E2E tests
 * (PAYMENT_PROVIDER=mock). Initiations always succeed; callbacks are
 * constructed by the test harness calling buildSuccessCallback().
 */
export class MockPaymentProvider implements PaymentProvider {
  public readonly providerId = 'MPESA' as const;
  private readonly initiated = new Map<string, StkPushRequest>();

  public async initiateStkPush(request: StkPushRequest): Promise<StkPushResponse> {
    const providerTransactionId = `MOCK-${randomUUID()}`;
    this.initiated.set(providerTransactionId, request);
    return { providerTransactionId, merchantRequestId: `MOCKMR-${providerTransactionId}`, accepted: true };
  }

  public async queryTransaction(providerTransactionId: string): Promise<ProviderQueryResult> {
    if (this.initiated.has(providerTransactionId)) {
      return { status: 'PENDING' };
    }
    return { status: 'FAILED', providerTransactionId, reason: 'unknown to mock provider' };
  }

  public async parseCallback(rawBody: unknown): Promise<CallbackPayload> {
    if (typeof rawBody !== 'object' || rawBody === null) {
      throw new Error('Unparseable mock callback');
    }
    const body = rawBody as {
      providerTransactionId: string;
      resultCode: number;
      resultDesc?: string;
      amountMinor?: number;
      receipt?: string;
    };
    return {
      providerTransactionId: body.providerTransactionId,
      resultCode: body.resultCode,
      resultDesc: body.resultDesc ?? '',
      ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
      ...(body.receipt !== undefined ? { receipt: body.receipt } : {}),
      raw: rawBody as Record<string, unknown>,
    };
  }

  public buildSuccessCallback(providerTransactionId: string, amountMinor: number): Record<string, unknown> {
    return {
      providerTransactionId,
      resultCode: 0,
      resultDesc: 'The service request is processed successfully.',
      amountMinor,
      receipt: `MOCKRCPT-${providerTransactionId.slice(6, 14).toUpperCase()}`,
    };
  }
}
