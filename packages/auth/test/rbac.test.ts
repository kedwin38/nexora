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

  it('PLATFORM_OWNER holds every permission', () => {
    expect(permissionsForRole('PLATFORM_OWNER').length).toBe(PERMISSIONS.length);
  });

  it('SUPER_ADMIN holds every tenant-scoped permission but no platform.* permission', () => {
    const platformPerms = PERMISSIONS.filter((p) => p.startsWith('platform.'));
    expect(permissionsForRole('SUPER_ADMIN').length).toBe(PERMISSIONS.length - platformPerms.length);
    for (const p of platformPerms) {
      expect(roleHasPermission('SUPER_ADMIN', p)).toBe(false);
    }
  });

  it('only PLATFORM_OWNER holds platform.* permissions', () => {
    for (const p of PERMISSIONS.filter((x) => x.startsWith('platform.'))) {
      const holders = ROLES.filter((role) => roleHasPermission(role, p));
      expect(holders).toEqual(['PLATFORM_OWNER']);
    }
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

  it('only PLATFORM_OWNER and SUPER_ADMIN can assign roles', () => {
    const canAssign = ['PLATFORM_OWNER', 'SUPER_ADMIN'];
    for (const role of ROLES) {
      expect(roleHasPermission(role, 'role.assign')).toBe(canAssign.includes(role));
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
