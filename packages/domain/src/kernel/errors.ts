/**
 * Domain error taxonomy.
 *
 * Every error surfaced to an API client or worker carries a stable machine
 * `code`, a human `message`, a `retryable` flag, and (when available) the
 * correlation ID of the causal request. Stack traces and secrets never leave
 * the process boundary.
 */

import { randomUUID } from 'node:crypto';

export type CorrelationId = string;

export interface NexoraErrorShape {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId?: CorrelationId;
  readonly details?: Record<string, unknown>;
}

export class NexoraError extends Error implements NexoraErrorShape {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly correlationId?: CorrelationId;
  public readonly details?: Record<string, unknown>;

  constructor(shape: NexoraErrorShape) {
    super(shape.message);
    this.name = new.target.name;
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.correlationId = shape.correlationId;
    this.details = shape.details;
  }

  public toJSON(): NexoraErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.correlationId !== undefined ? { correlationId: this.correlationId } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class ValidationError extends NexoraError {
  constructor(message: string, details?: Record<string, unknown>, correlationId?: CorrelationId) {
    super({ code: 'VALIDATION_FAILED', message, retryable: false, correlationId, details });
  }
}

export class NotFoundError extends NexoraError {
  constructor(resource: string, id: string, correlationId?: CorrelationId) {
    super({
      code: 'NOT_FOUND',
      message: `${resource} '${id}' was not found.`,
      retryable: false,
      correlationId,
      details: { resource, id },
    });
  }
}

export class ConflictError extends NexoraError {
  constructor(message: string, details?: Record<string, unknown>, correlationId?: CorrelationId) {
    super({ code: 'CONFLICT', message, retryable: false, correlationId, details });
  }
}

/** Raised when a state machine transition is not permitted from the current state. */
export class InvalidStateTransitionError extends NexoraError {
  constructor(
    entity: string,
    from: string,
    to: string,
    correlationId?: CorrelationId,
  ) {
    super({
      code: 'INVALID_STATE_TRANSITION',
      message: `Illegal transition on ${entity}: ${from} -> ${to}.`,
      retryable: false,
      correlationId,
      details: { entity, from, to },
    });
  }
}

/** Raised when a duplicate idempotent submission is rejected or deduplicated. */
export class IdempotencyError extends NexoraError {
  constructor(message: string, details?: Record<string, unknown>, correlationId?: CorrelationId) {
    super({ code: 'IDEMPOTENCY_CONFLICT', message, retryable: false, correlationId, details });
  }
}

export class UnauthorizedError extends NexoraError {
  constructor(message = 'Authentication required.', correlationId?: CorrelationId) {
    super({ code: 'UNAUTHORIZED', message, retryable: false, correlationId });
  }
}

export class ForbiddenError extends NexoraError {
  constructor(permission: string, correlationId?: CorrelationId) {
    super({
      code: 'FORBIDDEN',
      message: `Missing permission '${permission}'.`,
      retryable: false,
      correlationId,
      details: { permission },
    });
  }
}

/** Wrapper for failures in external systems (routers, payment providers). */
export class ExternalSystemError extends NexoraError {
  constructor(
    system: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; correlationId?: CorrelationId } = {},
  ) {
    super({
      code: `EXTERNAL_${system.toUpperCase()}_ERROR`,
      message,
      retryable: options.retryable ?? true,
      correlationId: options.correlationId,
      details: options.details,
    });
  }
}

export function newCorrelationId(): CorrelationId {
  return randomUUID();
}

export function newEventId(): string {
  return randomUUID();
}
