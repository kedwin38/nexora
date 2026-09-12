/**
 * Platform billing (§91b): the OWNER sells monthly subscription tiers to ISPs.
 * This is distinct from an ISP billing its own customers — it bills the tenant
 * (company) for platform access, collected to the platform's own M-Pesa.
 *
 * Model: a tenant on a plan carries `currentPeriodEnd`. When it lapses the
 * billing cycle issues a PENDING PlatformInvoice for the next interval and
 * advances the period. Unpaid invoices past their due date flip to OVERDUE and
 * mark the tenant PAST_DUE. Paying an invoice restores ACTIVE. A trial simply
 * sets the first `currentPeriodEnd` in the future so no invoice is raised until
 * it ends.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import type { PaymentProvider } from '@nexora/payment-sdk';
import type { PaymentProviderResolver } from './payment-reconciliation.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DUE_DAYS = 7;
const ATTEMPT_STALE_MS = 3 * 60_000;
const ATTEMPT_HARD_MS = 15 * 60_000;

function addInterval(from: Date, interval: string): Date {
  const d = new Date(from);
  if (interval === 'YEARLY') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function invoiceNumber(now: Date): string {
  return `INV-${now.getTime().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export interface BillingCycleResult {
  readonly invoicesIssued: number;
  readonly markedOverdue: number;
  readonly markedPastDue: number;
}

/** Idempotent-ish recurring billing sweep. Safe to run frequently. */
export async function runPlatformBillingCycle(prisma: PrismaClient, now: Date = new Date()): Promise<BillingCycleResult> {
  let invoicesIssued = 0;
  let markedOverdue = 0;
  let markedPastDue = 0;

  // 1. Issue invoices for tenants whose period has lapsed (and aren't cancelled).
  const dueTenants = await prisma.tenant.findMany({
    where: {
      planId: { not: null },
      planStatus: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
      currentPeriodEnd: { lte: now },
    },
    include: { plan: true },
    take: 200,
  });
  for (const tenant of dueTenants) {
    if (tenant.plan === null) continue;
    // Don't double-issue: skip if an unpaid invoice already covers this period.
    const openInvoice = await prisma.platformInvoice.findFirst({
      where: { tenantId: tenant.id, status: { in: ['PENDING', 'OVERDUE', 'DRAFT'] } },
    });
    const periodStart = tenant.currentPeriodEnd ?? now;
    const periodEnd = addInterval(periodStart, tenant.plan.interval);
    if (openInvoice === null && tenant.plan.priceMinor > 0) {
      await prisma.platformInvoice.create({
        data: {
          number: invoiceNumber(now),
          tenantId: tenant.id,
          planId: tenant.plan.id,
          amountMinor: tenant.plan.priceMinor,
          currency: tenant.plan.currency,
          periodStart,
          periodEnd,
          dueDate: new Date(now.getTime() + DUE_DAYS * MS_PER_DAY),
          status: 'PENDING',
        },
      });
      invoicesIssued += 1;
    }
    // Advance the period and move a lapsed trial into ACTIVE billing.
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        currentPeriodEnd: periodEnd,
        ...(tenant.planStatus === 'TRIALING' && tenant.plan.priceMinor > 0 ? { planStatus: 'ACTIVE' } : {}),
      },
    });
  }

  // 2. Flip overdue invoices + tenants.
  const overdue = await prisma.platformInvoice.findMany({
    where: { status: 'PENDING', dueDate: { lt: now } },
    take: 500,
  });
  for (const inv of overdue) {
    await prisma.platformInvoice.update({ where: { id: inv.id }, data: { status: 'OVERDUE' } });
    markedOverdue += 1;
    const t = await prisma.tenant.findUnique({ where: { id: inv.tenantId }, select: { planStatus: true } });
    if (t !== null && t.planStatus !== 'CANCELLED' && t.planStatus !== 'PAST_DUE') {
      await prisma.tenant.update({ where: { id: inv.tenantId }, data: { planStatus: 'PAST_DUE' } });
      markedPastDue += 1;
    }
  }

  return { invoicesIssued, markedOverdue, markedPastDue };
}

/** Marks a platform invoice paid and restores the tenant's standing. */
export async function markPlatformInvoicePaid(
  prisma: PrismaClient,
  invoiceId: string,
  input: { receipt?: string; providerTransactionId?: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const claim = await tx.platformInvoice.updateMany({
      where: { id: invoiceId, status: { in: ['PENDING', 'OVERDUE', 'DRAFT'] } },
      data: {
        status: 'PAID',
        paidAt: now,
        ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
        ...(input.providerTransactionId !== undefined ? { providerTransactionId: input.providerTransactionId } : {}),
      },
    });
    if (claim.count === 0) return; // already terminal / concurrent
    const invoice = await tx.platformInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: invoice.tenantId } });
    // A paid invoice clears past-due and extends the covered period if newer.
    const extendPeriod = tenant.currentPeriodEnd === null || invoice.periodEnd > tenant.currentPeriodEnd;
    await tx.tenant.update({
      where: { id: invoice.tenantId },
      data: {
        planStatus: 'ACTIVE',
        ...(extendPeriod ? { currentPeriodEnd: invoice.periodEnd } : {}),
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'PLATFORM_INVOICE_PAID',
        aggregateType: 'PlatformInvoice',
        aggregateId: invoice.id,
        payload: { invoiceId: invoice.id, tenantId: invoice.tenantId, amountMinor: invoice.amountMinor } as Prisma.InputJsonValue,
        correlationId: `platform-invoice-${invoice.id}`,
      },
    });
  });
}

/** Closes a failed/cancelled/timed-out STK ATTEMPT on an invoice so it can be
 *  retried. The invoice itself stays owed (PENDING/OVERDUE) — never hangs. */
export async function closePlatformInvoiceAttempt(
  prisma: PrismaClient,
  invoiceId: string,
  reason: string,
): Promise<void> {
  await prisma.platformInvoice.updateMany({
    where: { id: invoiceId, status: { in: ['PENDING', 'OVERDUE'] } },
    data: { providerTransactionId: null, failureReason: reason.slice(0, 300) },
  });
}

export interface PlatformInvoiceReconResult {
  readonly checked: number;
  readonly paid: number;
  readonly attemptsClosed: number;
  readonly stillPending: number;
  readonly providerErrors: number;
}

/**
 * Sweeps in-flight ISP→platform invoice payments to a terminal ATTEMPT state,
 * mirroring customer-payment reconciliation: SUCCESS marks the invoice paid;
 * a cancelled/timed-out/failed STK closes the attempt (so the ISP can retry);
 * an unresolvable attempt past the hard deadline is closed too. No payment
 * attempt is ever left hanging.
 */
export async function runPlatformInvoiceReconciliation(
  prisma: PrismaClient,
  resolveProvider: PaymentProvider | PaymentProviderResolver,
  now: Date = new Date(),
): Promise<PlatformInvoiceReconResult> {
  const provider: PaymentProviderResolver =
    typeof (resolveProvider as PaymentProvider).queryTransaction === 'function'
      ? async () => resolveProvider as PaymentProvider
      : (resolveProvider as PaymentProviderResolver);

  const inFlight = await prisma.platformInvoice.findMany({
    where: { status: { in: ['PENDING', 'OVERDUE'] }, providerTransactionId: { not: null } },
    take: 100,
  });

  let paid = 0;
  let attemptsClosed = 0;
  let stillPending = 0;
  let providerErrors = 0;

  for (const inv of inFlight) {
    if (inv.providerTransactionId === null) continue;
    const meta = (inv.metadata ?? {}) as { payAttemptAt?: string };
    const attemptAt = meta.payAttemptAt !== undefined ? new Date(meta.payAttemptAt).getTime() : inv.updatedAt.getTime();
    if (now.getTime() - attemptAt < ATTEMPT_STALE_MS) {
      stillPending += 1;
      continue;
    }
    const pastHard = now.getTime() - attemptAt >= ATTEMPT_HARD_MS;
    const p = await provider({ tenantId: 'platform', provider: inv.provider }).catch(() => null);
    if (p === null) {
      if (pastHard) {
        await closePlatformInvoiceAttempt(prisma, inv.id, 'Provider unavailable past deadline');
        attemptsClosed += 1;
      } else providerErrors += 1;
      continue;
    }
    try {
      const result = await p.queryTransaction(inv.providerTransactionId);
      if (result.status === 'SUCCESS') {
        await markPlatformInvoicePaid(prisma, inv.id, { receipt: result.receipt ?? inv.providerTransactionId, providerTransactionId: inv.providerTransactionId, now });
        paid += 1;
      } else if (result.status === 'PENDING') {
        if (pastHard) {
          await closePlatformInvoiceAttempt(prisma, inv.id, 'STK timed out (still processing past deadline)');
          attemptsClosed += 1;
        } else stillPending += 1;
      } else {
        const outcome = result.outcome ?? 'FAILED';
        await closePlatformInvoiceAttempt(prisma, inv.id, `RECONCILED: ${outcome} — ${result.reason}`);
        attemptsClosed += 1;
      }
    } catch {
      if (pastHard) {
        await closePlatformInvoiceAttempt(prisma, inv.id, 'Provider query failed past deadline');
        attemptsClosed += 1;
      } else providerErrors += 1;
    }
  }

  return { checked: inFlight.length, paid, attemptsClosed, stillPending, providerErrors };
}
