/**
 * Outbox ports.
 *
 * Business state changes and their events are written in the SAME database
 * transaction (architecture map §29). The dispatcher then publishes persisted
 * outbox records to the queue. This module defines the port (interface) the
 * domain depends on; the Prisma-backed adapter lives in packages/db and the
 * dispatcher loop in apps/worker (Stage 6).
 */

import {
  createEventEnvelope,
  newEventId,
  type EventEnvelope,
  type EventEnvelopeInput,
} from '@nexora/domain';

/** Persists an event intent alongside the business mutation, inside the caller's transaction. */
export interface OutboxWriter {
  append(input: EventEnvelopeInput): EventEnvelope;
}

export type OutboxStatus = 'PENDING' | 'DISPATCHED' | 'FAILED' | 'DEAD';

export interface OutboxRecord {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly createdAt: Date;
}

/**
 * Publishes persisted outbox records to the transport (BullMQ/Redis).
 * Implementations must be at-least-once and tolerate duplicate delivery.
 */
export interface EventPublisher {
  publish(record: OutboxRecord): Promise<void>;
}

/** Collects event intents within a unit of work; the repository flushes them in the DB transaction. */
export class OutboxCollector implements OutboxWriter {
  private readonly collected: EventEnvelope[] = [];

  public append(input: EventEnvelopeInput): EventEnvelope {
    const envelope = createEventEnvelope(input, newEventId);
    this.collected.push(envelope);
    return envelope;
  }

  public drain(): EventEnvelope[] {
    return [...this.collected];
  }

  public get size(): number {
    return this.collected.length;
  }
}
