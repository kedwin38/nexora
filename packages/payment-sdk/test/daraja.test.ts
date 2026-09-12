import { describe, expect, it } from 'vitest';
import {
  classifyStkResultCode,
  darajaPassword,
  darajaTimestamp,
  MockPaymentProvider,
  MpesaDarajaProvider,
  parseStkCallback,
} from '@nexora/payment-sdk';

describe('darajaTimestamp / darajaPassword', () => {
  it('formats timestamps as yyyyMMddHHmmss', () => {
    expect(darajaTimestamp(new Date('2026-09-01T14:05:09'))).toBe('20260901140509');
  });

  it('derives the documented base64(shortcode+passkey+timestamp) password', () => {
    const expected = Buffer.from('174379passkey20260901140509').toString('base64');
    expect(darajaPassword('174379', 'passkey', '20260901140509')).toBe(expected);
  });
});

describe('parseStkCallback', () => {
  const successBody = {
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_191220191020363925',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 1 },
            { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
            { Name: 'Balance' },
            { Name: 'TransactionDate', Value: 20191219102115 },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ],
        },
      },
    },
  };

  it('parses a successful callback with amount and receipt', () => {
    const payload = parseStkCallback(successBody);
    expect(payload).not.toBeNull();
    expect(payload?.providerTransactionId).toBe('ws_CO_191220191020363925');
    expect(payload?.resultCode).toBe(0);
    expect(payload?.amountMinor).toBe(100);
    expect(payload?.receipt).toBe('NLJ7RT61SV');
  });

  it('parses a cancelled callback (1032) without metadata', () => {
    const payload = parseStkCallback({
      Body: { stkCallback: { CheckoutRequestID: 'ws_CO_X', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } },
    });
    expect(payload?.resultCode).toBe(1032);
    expect(payload?.receipt).toBeUndefined();
  });

  it('returns null for malformed bodies', () => {
    expect(parseStkCallback(null)).toBeNull();
    expect(parseStkCallback({})).toBeNull();
    expect(parseStkCallback({ Body: {} })).toBeNull();
    expect(parseStkCallback('string')).toBeNull();
  });
});

describe('classifyStkResultCode', () => {
  it('maps success, cancel, timeout and generic failure', () => {
    expect(classifyStkResultCode(0)).toBe('SUCCESS');
    expect(classifyStkResultCode(1032)).toBe('CANCELLED');
    expect(classifyStkResultCode(1037)).toBe('TIMEOUT');
    expect(classifyStkResultCode(1019)).toBe('TIMEOUT');
    expect(classifyStkResultCode(1)).toBe('FAILED');
    expect(classifyStkResultCode(2001)).toBe('FAILED');
  });
});

describe('MpesaDarajaProvider STK body (paybill vs till)', () => {
  function captureBody(channel: 'paybill' | 'till', partyB?: string): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/oauth/')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: '3600' }), { status: 200 });
      }
      captured = JSON.parse(init?.body ?? '{}');
      return new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new MpesaDarajaProvider({
      env: 'sandbox',
      consumerKey: 'k',
      consumerSecret: 's',
      shortcode: '174379',
      channel,
      ...(partyB !== undefined ? { partyB } : {}),
      passkey: 'passkey',
      callbackUrl: 'https://x/cb',
      fetchImpl,
    });
    return provider
      .initiateStkPush({ phoneNumber: '254712345678', amountMinor: 3000, accountReference: 'NEXORA', description: 'Day Pass', transactionReference: 'idem-1' })
      .then(() => captured);
  }

  it('uses CustomerPayBillOnline and credits the shortcode for paybill', async () => {
    const body = await captureBody('paybill');
    expect(body.TransactionType).toBe('CustomerPayBillOnline');
    expect(body.PartyB).toBe('174379');
  });

  it('uses CustomerBuyGoodsOnline and credits the till for a till', async () => {
    const body = await captureBody('till', '5678901');
    expect(body.TransactionType).toBe('CustomerBuyGoodsOnline');
    expect(body.PartyB).toBe('5678901');
    expect(body.BusinessShortCode).toBe('174379');
  });

  it('defaults a till PartyB to the shortcode when unset', async () => {
    const body = await captureBody('till');
    expect(body.PartyB).toBe('174379');
  });
});

describe('MockPaymentProvider', () => {
  it('initiates, acknowledges pending, and parses its own success callback', async () => {
    const provider = new MockPaymentProvider();
    const push = await provider.initiateStkPush({
      phoneNumber: '254712345678',
      amountMinor: 3000,
      accountReference: 'NEXORA',
      description: 'Day Pass',
      transactionReference: 'idem-1',
    });
    expect(push.accepted).toBe(true);

    const query = await provider.queryTransaction(push.providerTransactionId);
    expect(query.status).toBe('PENDING');

    const raw = provider.buildSuccessCallback(push.providerTransactionId, 3000);
    const parsed = await provider.parseCallback(raw);
    expect(parsed.resultCode).toBe(0);
    expect(parsed.amountMinor).toBe(3000);
    expect(parsed.receipt).toMatch(/^MOCKRCPT-/);
  });
});
