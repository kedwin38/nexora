/**
 * Branded ID types.
 *
 * IDs are UUIDv4 strings at rest; branding prevents cross-assignment of
 * semantically distinct identifiers (e.g. passing a PaymentId where a
 * SubscriptionId is required). See ADR-004.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

function branded<T, B extends string>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}

// ---- Entity ID types -------------------------------------------------------

export type CustomerId = Brand<string, 'CustomerId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type PackageId = Brand<string, 'PackageId'>;
export type SubscriptionId = Brand<string, 'SubscriptionId'>;
export type PaymentId = Brand<string, 'PaymentId'>;
export type RouterId = Brand<string, 'RouterId'>;
export type NetworkOperationId = Brand<string, 'NetworkOperationId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type UserId = Brand<string, 'UserId'>;
export type JobId = Brand<string, 'JobId'>;
export type AuditLogId = Brand<string, 'AuditLogId'>;
export type OutboxEventId = Brand<string, 'OutboxEventId'>;

// ---- Constructors ----------------------------------------------------------

export const asCustomerId = (v: string): CustomerId => branded(v);
export const asDeviceId = (v: string): DeviceId => branded(v);
export const asPackageId = (v: string): PackageId => branded(v);
export const asSubscriptionId = (v: string): SubscriptionId => branded(v);
export const asPaymentId = (v: string): PaymentId => branded(v);
export const asRouterId = (v: string): RouterId => branded(v);
export const asNetworkOperationId = (v: string): NetworkOperationId => branded(v);
export const asSessionId = (v: string): SessionId => branded(v);
export const asUserId = (v: string): UserId => branded(v);
export const asJobId = (v: string): JobId => branded(v);
export const asAuditLogId = (v: string): AuditLogId => branded(v);
export const asOutboxEventId = (v: string): OutboxEventId => branded(v);

/** Untyped identifier used at system boundaries before validation. */
export type RawId = string;
