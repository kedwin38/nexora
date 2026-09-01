/**
 * Seed: RBAC roles + permissions, super admin, test packages with policies,
 * one test router (Stage 1 step 4; architecture map §94).
 *
 * Idempotent: upserts everywhere; safe to run on every environment bootstrap.
 * Super-admin credentials come from ADMIN_EMAIL / ADMIN_PASSWORD env vars —
 * never hardcoded (ADR: no secrets in source).
 */

import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '@nexora/auth';

const prisma = new PrismaClient();

async function seedRbac(): Promise<void> {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  for (const name of ROLES) {
    const role = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    for (const key of ROLE_PERMISSIONS[name]) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
  console.log(`RBAC seeded: ${ROLES.length} roles, ${PERMISSIONS.length} permissions`);
}

async function seedSuperAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping super-admin creation.');
    return;
  }
  const superRole = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
  const passwordHash = await hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash, displayName: 'Super Admin', roleId: superRole.id },
  });
  console.log(`Super admin seeded: ${email}`);
}

async function seedPackages(): Promise<void> {
  const definitions = [
    {
      name: 'Hour Pass',
      priceMinor: 1000,
      durationSeconds: 3600,
      maxDevices: 1,
      downloadKbps: 2048,
      uploadKbps: 1024,
      fupLimitBytes: null as bigint | null,
    },
    {
      name: 'Day Pass',
      priceMinor: 3000,
      durationSeconds: 86400,
      maxDevices: 2,
      downloadKbps: 5120,
      uploadKbps: 2560,
      fupLimitBytes: 5n * 1024n * 1024n * 1024n, // 5 GiB
    },
    {
      name: 'Week Pass',
      priceMinor: 15000,
      durationSeconds: 604800,
      maxDevices: 3,
      downloadKbps: 10240,
      uploadKbps: 5120,
      fupLimitBytes: 25n * 1024n * 1024n * 1024n, // 25 GiB
    },
  ];

  for (const [index, def] of definitions.entries()) {
    const pkg = await prisma.package.upsert({
      where: { tenantId_name_version: { tenantId: 'default', name: def.name, version: 1 } },
      update: {
        priceMinor: def.priceMinor,
        durationSeconds: def.durationSeconds,
        maxDevices: def.maxDevices,
        status: 'ACTIVE',
      },
      create: {
        name: def.name,
        priceMinor: def.priceMinor,
        durationSeconds: def.durationSeconds,
        maxDevices: def.maxDevices,
        displayOrder: index,
        status: 'ACTIVE',
      },
    });
    const policyValues = {
      downloadKbps: def.downloadKbps,
      uploadKbps: def.uploadKbps,
      fupLimitBytes: def.fupLimitBytes,
      fupWarningPercent: 80,
      fupThrottleDownloadKbps: Math.floor(def.downloadKbps / 4),
      fupThrottleUploadKbps: Math.floor(def.uploadKbps / 4),
      fupResetPolicy: def.fupLimitBytes === null ? ('NONE' as const) : ('DAILY' as const),
    };
    await prisma.packagePolicy.upsert({
      where: { packageId: pkg.id },
      update: policyValues,
      create: { packageId: pkg.id, ...policyValues },
    });
  }
  console.log(`Packages seeded: ${definitions.length}`);
}

async function seedRouter(): Promise<void> {
  const router = await prisma.router.upsert({
    where: { tenantId_host_port: { tenantId: 'default', host: '192.168.88.1', port: 8728 } },
    update: {},
    create: {
      name: 'test-router-01',
      vendor: 'MIKROTIK',
      host: '192.168.88.1',
      port: 8728,
      username: 'admin',
      passwordEnvVar: 'ROUTER_01_PASSWORD',
      site: 'test-site',
    },
  });
  const caps = [
    'CAP_AUTH',
    'CAP_DEAUTH',
    'CAP_RATE_LIMIT',
    'CAP_SESSION_CONTROL',
    'CAP_USAGE',
    'CAP_HEALTH',
  ] as const;
  for (const capability of caps) {
    await prisma.routerCapabilityEntry.upsert({
      where: { routerId_capability: { routerId: router.id, capability } },
      update: {},
      create: { routerId: router.id, capability, supported: true },
    });
  }
  console.log('Test router seeded: test-router-01 (MIKROTIK @192.168.88.1)');
}

async function main(): Promise<void> {
  await seedRbac();
  await seedSuperAdmin();
  await seedPackages();
  await seedRouter();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error('Seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
