import { describe, expect, it } from 'vitest';
import {
  darajaPassword,
  darajaTimestamp,
  MockPaymentProvider,
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
