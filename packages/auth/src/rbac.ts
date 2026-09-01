/**
 * Role-Based Access Control.
 *
 * The permission matrix is pure data — testable, seedable into the Role /
 * Permission / RolePermission tables (Stage 2), and enforceable by API
 * middleware. Architecture map §38; persona §4.3.
 */

export const ROLES = [
  'SUPER_ADMIN',
  'NETWORK_ADMIN',
  'BILLING_ADMIN',
  'SUPPORT_AGENT',
  'ANALYST',
  'READ_ONLY',
  'CUSTOMER',
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Customer
  'customer.read',
  'customer.write',
  'customer.suspend',
  'customer.block',
  // Subscription
  'subscription.read',
  'subscription.write',
  'subscription.cancel',
  // Payment
  'payment.read',
  'payment.refund',
  'payment.config.manage',
  'payment.reconciliation.run',
  // Package
  'package.read',
  'package.write',
  // Router & network
  'router.read',
  'router.manage',
  'session.read',
  'session.disconnect',
  'policy.manage',
  'network_operation.read',
  'network_operation.retry',
  // FUP
  'fup.read',
  'fup.reset',
  // Users & RBAC
  'user.read',
  'user.write',
  'role.assign',
  // System
  'audit.read',
  'system.manage',
  'monitoring.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  NETWORK_ADMIN: [
    'customer.read',
    'subscription.read',
    'router.read',
    'router.manage',
    'session.read',
    'session.disconnect',
    'policy.manage',
    'network_operation.read',
    'network_operation.retry',
    'fup.read',
    'fup.reset',
    'audit.read',
    'monitoring.read',
  ],
  BILLING_ADMIN: [
    'customer.read',
    'customer.write',
    'subscription.read',
    'subscription.write',
    'subscription.cancel',
    'payment.read',
    'payment.refund',
    'payment.config.manage',
    'payment.reconciliation.run',
    'package.read',
    'package.write',
    'audit.read',
  ],
  SUPPORT_AGENT: [
    'customer.read',
    'subscription.read',
    'payment.read',
    'session.read',
    'session.disconnect',
    'fup.read',
  ],
  ANALYST: [
    'customer.read',
    'subscription.read',
    'payment.read',
    'package.read',
    'router.read',
    'session.read',
    'fup.read',
    'monitoring.read',
  ],
  READ_ONLY: ['customer.read', 'subscription.read', 'payment.read', 'package.read', 'router.read'],
  CUSTOMER: ['customer.read', 'subscription.read', 'payment.read', 'package.read'],
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
