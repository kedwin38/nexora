/**
 * System event type catalog.
 *
 * These are the event_type values written to the outbox. Adding a value here
 * is a contract change: workers, projections and dashboards may subscribe.
 */

export const EVENT_TYPES = [
  // Customer & identity
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_SUSPENDED',
  'CUSTOMER_REACTIVATED',
  'CUSTOMER_BLOCKED',
  'CUSTOMER_DELETED',
  'GUEST_IDENTITY_CREATED',
  // Payments
  'PAYMENT_INITIATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_FAILED',
  'PAYMENT_CANCELLED',
  'PAYMENT_REVERSED',
  'PAYMENT_REFUNDED',
  // Subscriptions
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_RENEWED',
  'SUBSCRIPTION_SUSPENDED',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_CANCELLED',
  // Sessions & usage
  'SESSION_STARTED',
  'SESSION_ENDED',
  'USAGE_UPDATED',
  // FUP
  'FUP_WARNING',
  'FUP_REACHED',
  'FUP_THROTTLED',
  'FUP_RESET',
  // Network control plane
  'NETWORK_PROVISION_REQUESTED',
  'NETWORK_PROVISIONED',
  'NETWORK_PROVISION_FAILED',
  'NETWORK_DEPROVISIONED',
  'NETWORK_DRIFT_DETECTED',
  'NETWORK_SYNCHRONIZED',
  // Routers
  'ROUTER_ONLINE',
  'ROUTER_DEGRADED',
  'ROUTER_OFFLINE',
  // Admin & audit
  'ADMIN_ACTION_PERFORMED',
  'ROLE_ASSIGNED',
  // System
  'SYSTEM_STARTED',
  'SYSTEM_SHUTDOWN',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}
