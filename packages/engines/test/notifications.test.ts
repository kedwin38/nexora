import { describe, expect, it } from 'vitest';
import { LogNotificationSender, renderNotification } from '@nexora/engines';

describe('renderNotification templates (§62)', () => {
  it('renders payment confirmation with receipt and amount', () => {
    const draft = renderNotification('PAYMENT_CONFIRMED', { receipt: 'NLJ7RT61SV', amountMinor: 3000 });
    expect(draft).not.toBeNull();
    expect(draft?.channel).toBe('SMS');
    expect(draft?.body).toContain('KES 30.00');
    expect(draft?.body).toContain('NLJ7RT61SV');
  });

  it('renders FUP throttle with GB-rounded figures', () => {
    const draft = renderNotification('FUP_THROTTLED', { usedBytes: String(5 * 1024 ** 3), limitBytes: String(5 * 1024 ** 3) });
    expect(draft?.body).toContain('5.0GB');
    expect(draft?.subject).toBe('Speed reduced');
  });

  it('renders warning, activation, expiry and router-offline', () => {
    expect(renderNotification('FUP_WARNING', { usedBytes: '4294967296', limitBytes: String(5 * 1024 ** 3) })?.subject).toBe('Data warning');
    expect(renderNotification('SUBSCRIPTION_ACTIVATED', { packageName: 'Day Pass', expiry: '2026-09-02' })?.body).toContain('Day Pass');
    expect(renderNotification('SUBSCRIPTION_EXPIRED', {})?.subject).toBe('Package expired');
    expect(renderNotification('ROUTER_OFFLINE', {})?.channel).toBe('DASHBOARD');
  });

  it('returns null for non-notifiable events', () => {
    expect(renderNotification('USAGE_UPDATED', {})).toBeNull();
    expect(renderNotification('SYSTEM_STARTED', {})).toBeNull();
    expect(renderNotification('PAYMENT_INITIATED', {})).toBeNull();
  });
});

describe('LogNotificationSender', () => {
  it('writes a structured operator line without throwing', async () => {
    const sender = new LogNotificationSender();
    await expect(
      sender.send({
        id: 'n1',
        channel: 'SMS',
        triggerType: 'PAYMENT_CONFIRMED',
        subject: 'Payment confirmed',
        body: 'ok',
        to: '254712345678',
      }),
    ).resolves.toBeUndefined();
  });
});
