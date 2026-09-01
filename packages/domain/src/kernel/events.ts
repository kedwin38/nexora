/**
 * Canonical event envelope.
 *
 * All outbox-persisted events share this shape. `correlationId` ties every
 * record in a workflow back to the originating request; `causationId` points
 * at the event (if any) that directly caused this one.
 */

import type { CorrelationId } from './errors.js';

export interface EventEnvelope<TPayload = unknown> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
  readonly correlationId: CorrelationId;
  readonly causationId?: string;
  readonly occurredAt: string; // ISO-8601 UTC
  readonly version: number;
}

export interface EventEnvelopeInput<TPayload = unknown> {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  correlationId: CorrelationId;
  causationId?: string;
  occurredAt?: Date;
  version?: number;
}

export function createEventEnvelope<TPayload>(
  input: EventEnvelopeInput<TPayload>,
  generateEventId: () => string,
): EventEnvelope<TPayload> {
  return {
    eventId: generateEventId(),
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
    correlationId: input.correlationId,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    version: input.version ?? 1,
  };
}
