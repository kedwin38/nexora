import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  permissionsForRole,
  ROLES,
  roleHasPermission,
  ROLE_PERMISSIONS,
  type Permission,
} from '@nexora/auth';

describe('RBAC matrix integrity', () => {
  it('every role grants only declared permissions', () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(
          PERMISSIONS,
          `${role} grants undeclared permission ${permission}`,
        ).toContain(permission);
      }
    }
  });

  it('SUPER_ADMIN holds every permission', () => {
    expect(permissionsForRole('SUPER_ADMIN').length).toBe(PERMISSIONS.length);
  });

  it('every permission is reachable by at least one role', () => {
    for (const permission of PERMISSIONS) {
      const holders = ROLES.filter((role) => roleHasPermission(role, permission));
      expect(holders.length, `permission ${permission} is granted to no role`).toBeGreaterThan(0);
    }
  });

  it('only SUPER_ADMIN and BILLING_ADMIN can refund', () => {
    expect(roleHasPermission('SUPER_ADMIN', 'payment.refund')).toBe(true);
    expect(roleHasPermission('BILLING_ADMIN', 'payment.refund')).toBe(true);
    expect(roleHasPermission('SUPPORT_AGENT', 'payment.refund')).toBe(false);
    expect(roleHasPermission('NETWORK_ADMIN', 'payment.refund')).toBe(false);
  });

  it('only SUPER_ADMIN can assign roles', () => {
    expect(roleHasPermission('SUPER_ADMIN', 'role.assign')).toBe(true);
    for (const role of ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
      expect(roleHasPermission(role, 'role.assign')).toBe(false);
    }
  });

  it('CUSTOMER role has no write permissions', () => {
    for (const permission of permissionsForRole('CUSTOMER')) {
      expect(permission.endsWith('.write')).toBe(false);
      expect(permission.endsWith('.manage')).toBe(false);
      expect(permission.endsWith('.assign')).toBe(false);
    }
  });

  it('READ_ONLY has no destructive permissions', () => {
    const denied = ['customer.write', 'session.disconnect', 'payment.refund', 'system.manage'];
    for (const permission of denied) {
      expect(roleHasPermission('READ_ONLY', permission as Permission)).toBe(false);
    }
  });
});
