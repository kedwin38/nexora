/**
 * Explicit state machines for entity lifecycles.
 *
 * Invalid transitions throw InvalidStateTransitionError. Every valid and
 * invalid transition is covered by unit tests (test/state-machines.test.ts).
 * See architecture map sections 8, 13, 14, 18, 20, 24 and persona §2.D.
 */

import { InvalidStateTransitionError, type CorrelationId } from './kernel/errors.js';

export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly transitions: TransitionMap<S>;
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S, correlationId?: CorrelationId): void;
  allowedFrom(from: S): readonly S[];
}

export function createStateMachine<S extends string>(
  name: string,
  transitions: TransitionMap<S>,
): StateMachine<S> {
  const states = Object.keys(transitions) as S[];
  return {
    name,
    states,
    transitions,
    canTransition(from: S, to: S): boolean {
      return transitions[from]?.includes(to) ?? false;
    },
    assertTransition(from: S, to: S, correlationId?: CorrelationId): void {
      if (!this.canTransition(from, to)) {
        throw new InvalidStateTransitionError(name, from, to, correlationId);
      }
    },
    allowedFrom(from: S): readonly S[] {
      return transitions[from] ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Customer: PENDING -> ACTIVE -> SUSPENDED -> BLOCKED -> DELETED
// ---------------------------------------------------------------------------

export type CustomerStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'BLOCKED'
  | 'DELETED';

export const customerMachine = createStateMachine<CustomerStatus>('Customer', {
  PENDING: ['ACTIVE', 'BLOCKED', 'DELETED'],
  ACTIVE: ['SUSPENDED', 'BLOCKED', 'DELETED'],
  SUSPENDED: ['ACTIVE', 'BLOCKED', 'DELETED'],
  BLOCKED: ['ACTIVE', 'DELETED'],
  DELETED: [],
});

// ---------------------------------------------------------------------------
// Subscription: PENDING -> PROVISIONING -> ACTIVE -> FUP -> EXPIRED
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | 'PENDING'
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'FUP'
  | 'SUSPENDED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'PROVISIONING_FAILED';

export const subscriptionMachine = createStateMachine<SubscriptionStatus>('Subscription', {
  PENDING: ['PROVISIONING', 'CANCELLED', 'EXPIRED'],
  PROVISIONING: ['ACTIVE', 'PROVISIONING_FAILED', 'EXPIRED', 'CANCELLED'],
  PROVISIONING_FAILED: ['PROVISIONING', 'EXPIRED', 'CANCELLED'],
  ACTIVE: ['FUP', 'SUSPENDED', 'EXPIRED', 'CANCELLED'],
  FUP: ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'],
  SUSPENDED: ['ACTIVE', 'FUP', 'EXPIRED', 'CANCELLED'],
  EXPIRED: [],
  CANCELLED: [],
});

// ---------------------------------------------------------------------------
// Payment: INITIATED -> PENDING -> SUCCESS | FAILED | CANCELLED -> REVERSED/REFUNDED
// ---------------------------------------------------------------------------

export type PaymentStatus =
  | 'INITIATED'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED'
  | 'REVERSED'
  | 'REFUNDED';

export const paymentMachine = createStateMachine<PaymentStatus>('Payment', {
  INITIATED: ['PENDING', 'FAILED', 'CANCELLED'],
  PENDING: ['SUCCESS', 'FAILED', 'CANCELLED'],
  SUCCESS: ['REVERSED', 'REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REVERSED: [],
  REFUNDED: [],
});

// ---------------------------------------------------------------------------
// NetworkOperation: QUEUED -> PROCESSING -> VERIFYING -> SUCCESS | RETRYING
// ---------------------------------------------------------------------------

export type NetworkOperationStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'RETRYING'
  | 'PERMANENT_FAILURE';

export const networkOperationMachine = createStateMachine<NetworkOperationStatus>(
  'NetworkOperation',
  {
    QUEUED: ['PROCESSING', 'PERMANENT_FAILURE'],
    PROCESSING: ['VERIFYING', 'RETRYING', 'PERMANENT_FAILURE'],
    VERIFYING: ['SUCCESS', 'RETRYING', 'PERMANENT_FAILURE'],
    RETRYING: ['PROCESSING', 'PERMANENT_FAILURE'],
    SUCCESS: [],
    // Admin-forced retry of a permanently failed operation re-queues it (§4.4).
    PERMANENT_FAILURE: ['QUEUED'],
  },
);

// ---------------------------------------------------------------------------
// Session: CREATED -> AUTHENTICATING -> AUTHORIZED -> ONLINE -> ENDED
// ---------------------------------------------------------------------------

export type SessionStatus =
  | 'CREATED'
  | 'AUTHENTICATING'
  | 'AUTHORIZED'
  | 'ONLINE'
  | 'THROTTLED'
  | 'DISCONNECTING'
  | 'ENDED'
  | 'FAILED';

export const sessionMachine = createStateMachine<SessionStatus>('Session', {
  CREATED: ['AUTHENTICATING', 'FAILED'],
  AUTHENTICATING: ['AUTHORIZED', 'FAILED'],
  AUTHORIZED: ['ONLINE', 'DISCONNECTING', 'FAILED'],
  ONLINE: ['THROTTLED', 'DISCONNECTING', 'FAILED'],
  THROTTLED: ['ONLINE', 'DISCONNECTING', 'FAILED'],
  DISCONNECTING: ['ENDED', 'FAILED'],
  ENDED: [],
  FAILED: [],
});

// ---------------------------------------------------------------------------
// FUP: NORMAL -> WARNING -> FUP_REACHED -> THROTTLED -> NORMAL
// ---------------------------------------------------------------------------

export type FupStatus = 'NORMAL' | 'WARNING' | 'FUP_REACHED' | 'THROTTLED';

export const fupMachine = createStateMachine<FupStatus>('FUP', {
  NORMAL: ['WARNING', 'FUP_REACHED'],
  WARNING: ['NORMAL', 'FUP_REACHED'],
  FUP_REACHED: ['THROTTLED', 'NORMAL'],
  THROTTLED: ['NORMAL', 'WARNING'],
});
