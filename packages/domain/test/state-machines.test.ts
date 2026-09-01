import { describe, expect, it } from 'vitest';
import {
  createEventEnvelope,
  InvalidStateTransitionError,
  newCorrelationId,
  newEventId,
} from '@nexora/domain';
import {
  customerMachine,
  fupMachine,
  networkOperationMachine,
  paymentMachine,
  sessionMachine,
  subscriptionMachine,
  type StateMachine,
} from '@nexora/domain';

const machines: Array<StateMachine<string>> = [
  customerMachine,
  subscriptionMachine,
  paymentMachine,
  networkOperationMachine,
  sessionMachine,
  fupMachine,
];

describe('state machines — construction invariants', () => {
  it('every machine declares at least one state', () => {
    for (const m of machines) {
      expect(m.states.length).toBeGreaterThan(0);
    }
  });

  it('transition targets are always declared states', () => {
    for (const m of machines) {
      for (const from of m.states) {
        for (const to of m.allowedFrom(from)) {
          expect(
            m.states,
            `${m.name}: transition ${from} -> ${to} targets an undeclared state`,
          ).toContain(to);
        }
      }
    }
  });

  it('lifecycle machines have at least one terminal state', () => {
    const lifecycleMachines: Array<StateMachine<string>> = [
      customerMachine,
      subscriptionMachine,
      paymentMachine,
      networkOperationMachine,
      sessionMachine,
    ];
    for (const m of lifecycleMachines) {
      const terminals = m.states.filter((s) => m.allowedFrom(s).length === 0);
      expect(terminals.length, `${m.name}: expected at least one terminal state`).toBeGreaterThan(0);
    }
  });

  it('FUP is cyclic by design — no terminal states', () => {
    for (const state of fupMachine.states) {
      expect(fupMachine.allowedFrom(state).length, `FUP ${state} must be recoverable`).toBeGreaterThan(0);
    }
  });
});

describe('customerMachine', () => {
  it.each([
    ['PENDING', 'ACTIVE'],
    ['PENDING', 'DELETED'],
    ['ACTIVE', 'SUSPENDED'],
    ['ACTIVE', 'BLOCKED'],
    ['SUSPENDED', 'ACTIVE'],
    ['BLOCKED', 'ACTIVE'],
    ['BLOCKED', 'DELETED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => customerMachine.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['DELETED', 'ACTIVE'],
    ['PENDING', 'SUSPENDED'],
    ['BLOCKED', 'SUSPENDED'],
    ['ACTIVE', 'PENDING'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => customerMachine.assertTransition(from, to)).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('subscriptionMachine', () => {
  it.each([
    ['PENDING', 'PROVISIONING'],
    ['PROVISIONING', 'ACTIVE'],
    ['PROVISIONING', 'PROVISIONING_FAILED'],
    ['PROVISIONING_FAILED', 'PROVISIONING'],
    ['ACTIVE', 'FUP'],
    ['FUP', 'ACTIVE'],
    ['SUSPENDED', 'ACTIVE'],
    ['ACTIVE', 'EXPIRED'],
    ['FUP', 'CANCELLED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => subscriptionMachine.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['EXPIRED', 'ACTIVE'],
    ['CANCELLED', 'PROVISIONING'],
    ['PENDING', 'ACTIVE'],
    ['PENDING', 'FUP'],
    ['ACTIVE', 'PROVISIONING'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => subscriptionMachine.assertTransition(from, to)).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('paymentMachine', () => {
  it.each([
    ['INITIATED', 'PENDING'],
    ['INITIATED', 'FAILED'],
    ['PENDING', 'SUCCESS'],
    ['PENDING', 'FAILED'],
    ['PENDING', 'CANCELLED'],
    ['SUCCESS', 'REVERSED'],
    ['SUCCESS', 'REFUNDED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => paymentMachine.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['FAILED', 'SUCCESS'],
    ['CANCELLED', 'SUCCESS'],
    ['REFUNDED', 'SUCCESS'],
    ['REVERSED', 'PENDING'],
    ['INITIATED', 'SUCCESS'],
    ['INITIATED', 'REVERSED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => paymentMachine.assertTransition(from, to)).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('networkOperationMachine', () => {
  it.each([
    ['QUEUED', 'PROCESSING'],
    ['PROCESSING', 'VERIFYING'],
    ['VERIFYING', 'SUCCESS'],
    ['VERIFYING', 'RETRYING'],
    ['RETRYING', 'PROCESSING'],
    ['RETRYING', 'PERMANENT_FAILURE'],
    ['PROCESSING', 'PERMANENT_FAILURE'],
    ['QUEUED', 'PERMANENT_FAILURE'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => networkOperationMachine.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['QUEUED', 'SUCCESS'],
    ['QUEUED', 'VERIFYING'],
    ['SUCCESS', 'RETRYING'],
    ['SUCCESS', 'PROCESSING'],
    ['PERMANENT_FAILURE', 'PROCESSING'],
    ['PROCESSING', 'SUCCESS'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => networkOperationMachine.assertTransition(from, to)).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('sessionMachine', () => {
  it.each([
    ['CREATED', 'AUTHENTICATING'],
    ['AUTHENTICATING', 'AUTHORIZED'],
    ['AUTHORIZED', 'ONLINE'],
    ['ONLINE', 'THROTTLED'],
    ['THROTTLED', 'ONLINE'],
    ['ONLINE', 'DISCONNECTING'],
    ['DISCONNECTING', 'ENDED'],
    ['AUTHORIZED', 'FAILED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => sessionMachine.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['CREATED', 'ONLINE'],
    ['ENDED', 'ONLINE'],
    ['FAILED', 'AUTHORIZED'],
    ['ONLINE', 'ENDED'],
    ['ENDED', 'DISCONNECTING'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => sessionMachine.assertTransition(from, to)).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('fupMachine', () => {
  it.each([
    ['NORMAL', 'WARNING'],
    ['NORMAL', 'FUP_REACHED'],
    ['WARNING', 'FUP_REACHED'],
    ['WARNING', 'NORMAL'],
    ['FUP_REACHED', 'THROTTLED'],
    ['FUP_REACHED', 'NORMAL'],
    ['THROTTLED', 'NORMAL'],
    ['THROTTLED', 'WARNING'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => fupMachine.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['NORMAL', 'THROTTLED'],
    ['THROTTLED', 'FUP_REACHED'],
    ['WARNING', 'THROTTLED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => fupMachine.assertTransition(from, to)).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('event envelope', () => {
  it('creates a complete envelope with defaults', () => {
    const correlationId = newCorrelationId();
    const envelope = createEventEnvelope(
      {
        eventType: 'PAYMENT_CONFIRMED',
        aggregateType: 'Payment',
        aggregateId: 'pay_1',
        payload: { amount: 10 },
        correlationId,
      },
      newEventId,
    );

    expect(envelope.eventType).toBe('PAYMENT_CONFIRMED');
    expect(envelope.correlationId).toBe(correlationId);
    expect(envelope.version).toBe(1);
    expect(envelope.causationId).toBeUndefined();
    expect(() => new Date(envelope.occurredAt)).not.toThrow();
  });

  it('carries causation and version explicitly', () => {
    const envelope = createEventEnvelope(
      {
        eventType: 'SUBSCRIPTION_ACTIVATED',
        aggregateType: 'Subscription',
        aggregateId: 'sub_1',
        payload: {},
        correlationId: newCorrelationId(),
        causationId: 'evt_cause',
        version: 3,
      },
      newEventId,
    );
    expect(envelope.causationId).toBe('evt_cause');
    expect(envelope.version).toBe(3);
  });

  it('correlation and event IDs are unique per call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newEventId()));
    expect(ids.size).toBe(100);
    const correlations = new Set(Array.from({ length: 100 }, () => newCorrelationId()));
    expect(correlations.size).toBe(100);
  });
});
