/**
 * Notification engine (§62): event-triggered, template-driven, async.
 * Notifications must never block financial or network operations.
 *
 * Pipeline: outbox dispatch (worker) fans matching events into Notification
 * rows via `renderNotification`; a delivery loop sends PENDING rows through a
 * NotificationSender with bounded retries. Phase 1 sender: LogSender (operator
 * log) — SMS/email senders plug the same port when provider credentials land.
 */

import type { PrismaClient } from '@prisma/client';

export type NotificationChannelId = 'SMS' | 'EMAIL' | 'DASHBOARD';

export interface NotificationDraft {
  readonly channel: NotificationChannelId;
  readonly triggerType: string;
  readonly subject: string;
  readonly body: string;
}

export interface SenderNotification extends NotificationDraft {
  readonly id: string;
  readonly to: string | null;
}

export interface NotificationSender {
  readonly channel: NotificationChannelId;
  send(notification: SenderNotification): Promise<void>;
}

/** Phase 1 sender: operator log delivery (real, inspectable, zero-config). */
export class LogNotificationSender implements NotificationSender {
  public readonly channel: NotificationChannelId = 'SMS';

  public async send(notification: SenderNotification): Promise<void> {
    // Structured operator trail — replaced by an SMS gateway sender when
    // credentials land; the port and retry semantics stay identical.
    process.stdout.write(
      `[notification:${notification.channel}] to=${notification.to ?? '-'} subject="${notification.subject}" body="${notification.body}"\n`,
    );
  }
}

interface PayloadShape {
  readonly subscriptionId?: string;
  readonly paymentId?: string;
  readonly receipt?: string;
  readonly amountMinor?: number;
  readonly to?: string;
  readonly packageName?: string;
  readonly expiry?: string;
  readonly usedBytes?: string;
  readonly limitBytes?: string;
}

const toKes = (minor: number): string => `KES ${(minor / 100).toFixed(2)}`;
const toGb = (bytes: string | undefined): string =>
  bytes === undefined ? '-' : `${(Number(bytes) / 1024 ** 3).toFixed(1)}GB`;

/** Pure: outbox event -> notification draft (or null when not notifiable). */
export function renderNotification(eventType: string, payload: PayloadShape): NotificationDraft | null {
  switch (eventType) {
    case 'PAYMENT_CONFIRMED':
      return {
        channel: 'SMS',
        triggerType: eventType,
        subject: 'Payment confirmed',
        body: `Payment of ${toKes(payload.amountMinor ?? 0)} confirmed. Receipt ${payload.receipt ?? '-'}. Thank you.`,
      };
    case 'SUBSCRIPTION_ACTIVATED':
      return {
        channel: 'SMS',
        triggerType: eventType,
        subject: 'Package active',
        body: `Your ${payload.packageName ?? 'package'} is active until ${payload.expiry ?? '-'}. Enjoy!`,
      };
    case 'FUP_WARNING':
      return {
        channel: 'SMS',
        triggerType: eventType,
        subject: 'Data warning',
        body: `You have used ${toGb(payload.usedBytes)} of your ${toGb(payload.limitBytes)} data allowance.`,
      };
    case 'FUP_THROTTLED':
      return {
        channel: 'SMS',
        triggerType: eventType,
        subject: 'Speed reduced',
        body: `You reached your ${toGb(payload.limitBytes)} data limit; speeds are reduced until reset.`,
      };
    case 'SUBSCRIPTION_EXPIRED':
      return {
        channel: 'SMS',
        triggerType: eventType,
        subject: 'Package expired',
        body: 'Your package has expired. Purchase again to stay online.',
      };
    case 'ROUTER_OFFLINE':
      return {
        channel: 'DASHBOARD',
        triggerType: eventType,
        subject: 'Router offline',
        body: 'A router went offline. Check the admin console.',
      };
    default:
      return null;
  }
}

export interface DispatchNotifyResult {
  readonly created: number;
}

/** Fan dispatched outbox events into Notification rows (idempotent by
 *  correlationId of the event stored in Notification.metadata). */
export async function createNotificationsFromOutbox(
  prisma: PrismaClient,
  events: Array<{ id: string; eventType: string; aggregateType: string; aggregateId: string; payload: unknown; correlationId: string }>,
): Promise<DispatchNotifyResult> {
  let created = 0;
  for (const event of events) {
    const draft = renderNotification(event.eventType, (event.payload ?? {}) as PayloadShape);
    if (draft === null) continue;

    const existing = await prisma.notification.findFirst({
      where: { metadata: { path: ['outboxEventId'], equals: event.id } },
      select: { id: true },
    });
    if (existing !== null) continue; // idempotent fan-out

    const customerId =
      event.aggregateType === 'Customer' || event.aggregateType === 'Subscription' || event.aggregateType === 'Payment'
        ? await resolveCustomerId(prisma, event.aggregateType, event.aggregateId)
        : null;

    await prisma.notification.create({
      data: {
        customerId,
        triggerType: draft.triggerType,
        channel: draft.channel,
        subject: draft.subject,
        body: draft.body,
        status: 'PENDING',
        metadata: { outboxEventId: event.id },
      },
    });
    created += 1;
  }
  return { created };
}

async function resolveCustomerId(
  prisma: PrismaClient,
  aggregateType: string,
  aggregateId: string,
): Promise<string | null> {
  if (aggregateType === 'Customer') return aggregateId;
  if (aggregateType === 'Payment') {
    const payment = await prisma.payment.findUnique({ where: { id: aggregateId }, select: { customerId: true } });
    return payment?.customerId ?? null;
  }
  if (aggregateType === 'Subscription') {
    const sub = await prisma.subscription.findUnique({ where: { id: aggregateId }, select: { customerId: true } });
    return sub?.customerId ?? null;
  }
  return null;
}

export interface DeliveryResult {
  readonly sent: number;
  readonly failed: number;
}

/** Deliver due PENDING notifications through the sender (bounded retries). */
export async function deliverPendingNotifications(
  prisma: PrismaClient,
  sender: NotificationSender,
  limit = 25,
): Promise<DeliveryResult> {
  const due = await prisma.notification.findMany({
    where: { status: 'PENDING', scheduledFor: { lte: new Date() }, attempts: { lt: 5 } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { customer: { select: { phoneNumber: true, email: true } } },
  });

  let sent = 0;
  let failed = 0;
  for (const notification of due) {
    const to =
      (notification.channel === 'EMAIL' ? notification.customer?.email : notification.customer?.phoneNumber) ?? null;
    try {
      await sender.send({
        id: notification.id,
        channel: notification.channel as NotificationChannelId,
        triggerType: notification.triggerType,
        subject: notification.subject,
        body: notification.body,
        to,
      });
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } },
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          attempts: { increment: 1 },
          error: (error as Error).message.slice(0, 500),
          scheduledFor: new Date(Date.now() + 2 ** notification.attempts * 1000),
        },
      });
    }
  }
  return { sent, failed };
}
