/**
 * Outbox write helper — persists durable event intent (§29).
 * Call sites run inside (or immediately after) business transactions; this
 * appends the OutboxEvent row itself.
 */

import { isEventType, type EventType } from '@nexora/contracts';
import type { NexoraContext } from './context.js';

export interface OutboxEventInput {
  eventType: EventType | string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  correlationId: string;
  causationId?: string;
}

export async function createOutboxEvent(nexora: NexoraContext, input: OutboxEventInput): Promise<string> {
  if (!isEventType(input.eventType)) {
    throw new Error(`Unknown event type '${input.eventType}' — register it in @nexora/contracts first.`);
  }
  const record = await nexora.prisma.outboxEvent.create({
    data: {
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload as object,
      correlationId: input.correlationId,
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    },
    select: { id: true },
  });
  return record.id;
}
