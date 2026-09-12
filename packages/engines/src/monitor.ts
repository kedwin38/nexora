/**
 * AI operations monitor (owner-facing) — rule-based, Claude-ready.
 *
 * Scans the whole estate on a schedule and emits PlatformInsight rows the owner
 * sees as an "AI insights" feed: payment-failure spikes, revenue drops, router
 * outages, event/job backlogs, stuck payments, past-due ISPs, and growth. Each
 * signal is deduped within a window so the feed doesn't spam.
 *
 * LLM seam: `narrate` (optional) receives the computed signals and may return a
 * richer natural-language summary — wire an Anthropic call here behind an env
 * flag when a key is available. The heuristics run with or without it.
 */

import type { PrismaClient, Prisma } from '@prisma/client';

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

interface Signal {
  readonly code: string;
  readonly severity: Severity;
  readonly category: string;
  readonly title: string;
  readonly detail: string;
  readonly metrics?: Record<string, number | string>;
  readonly tenantId?: string;
}

export interface MonitorNarrator {
  (signals: ReadonlyArray<Signal>): Promise<string | null>;
}

export interface MonitorResult {
  readonly signalsFound: number;
  readonly insightsCreated: number;
  readonly narrative: string | null;
}

const DEDUPE_MS = 12 * 60 * 60 * 1000; // don't re-raise the same open signal within 12h
const DAY = 24 * 60 * 60 * 1000;

export async function runMonitorCycle(
  prisma: PrismaClient,
  options: { now?: Date; narrate?: MonitorNarrator } = {},
): Promise<MonitorResult> {
  const now = options.now ?? new Date();
  const signals: Signal[] = [];

  // --- Payments (last 24h) ---
  const since24 = new Date(now.getTime() - DAY);
  const [success24, failed24, expired24, cancelled24, pendingStuck] = await Promise.all([
    prisma.payment.count({ where: { status: 'SUCCESS', updatedAt: { gte: since24 } } }),
    prisma.payment.count({ where: { status: 'FAILED', updatedAt: { gte: since24 } } }),
    prisma.payment.count({ where: { status: 'EXPIRED', updatedAt: { gte: since24 } } }),
    prisma.payment.count({ where: { status: 'CANCELLED', updatedAt: { gte: since24 } } }),
    prisma.payment.count({ where: { status: 'PENDING', initiatedAt: { lt: new Date(now.getTime() - 20 * 60_000) } } }),
  ]);
  const resolved = success24 + failed24 + expired24 + cancelled24;
  const failures = failed24 + expired24 + cancelled24;
  if (resolved >= 5) {
    const rate = failures / resolved;
    if (rate >= 0.5) {
      signals.push({ code: 'PAYMENT_FAILURE_SPIKE', severity: 'CRITICAL', category: 'payments', title: 'High payment failure rate', detail: `${failures} of ${resolved} payments failed/cancelled/timed out in the last 24h (${Math.round(rate * 100)}%).`, metrics: { failures, resolved, ratePct: Math.round(rate * 100) } });
    } else if (rate >= 0.35) {
      signals.push({ code: 'PAYMENT_FAILURE_ELEVATED', severity: 'WARNING', category: 'payments', title: 'Elevated payment failures', detail: `${failures} of ${resolved} payments did not complete in the last 24h (${Math.round(rate * 100)}%).`, metrics: { failures, resolved, ratePct: Math.round(rate * 100) } });
    }
  }
  if (pendingStuck > 0) {
    signals.push({ code: 'PAYMENTS_STUCK_PENDING', severity: 'WARNING', category: 'payments', title: 'Payments stuck pending', detail: `${pendingStuck} payment(s) have been PENDING for over 20 minutes — reconciliation should be closing these out.`, metrics: { pendingStuck } });
  }

  // --- Revenue trend (7d vs prior 7d) ---
  const since7 = new Date(now.getTime() - 7 * DAY);
  const since14 = new Date(now.getTime() - 14 * DAY);
  const [rev7, rev14] = await Promise.all([
    prisma.payment.aggregate({ where: { status: 'SUCCESS', completedAt: { gte: since7 } }, _sum: { amountMinor: true } }),
    prisma.payment.aggregate({ where: { status: 'SUCCESS', completedAt: { gte: since14, lt: since7 } }, _sum: { amountMinor: true } }),
  ]);
  const cur = rev7._sum.amountMinor ?? 0;
  const prev = rev14._sum.amountMinor ?? 0;
  if (prev > 0 && cur < prev * 0.6) {
    signals.push({ code: 'REVENUE_DROP', severity: 'WARNING', category: 'growth', title: 'Revenue is falling', detail: `Successful revenue in the last 7 days (KES ${(cur / 100).toFixed(0)}) is down ${Math.round((1 - cur / prev) * 100)}% versus the prior week.`, metrics: { curMinor: cur, prevMinor: prev } });
  }

  // --- Network / reliability ---
  const [routersOffline, outboxDead, outboxPending, jobsFailed24] = await Promise.all([
    prisma.router.count({ where: { status: 'OFFLINE' } }),
    prisma.outboxEvent.count({ where: { status: 'DEAD' } }),
    prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
    prisma.job.count({ where: { status: 'FAILED', updatedAt: { gte: since24 } } }),
  ]);
  if (routersOffline > 0) {
    signals.push({ code: 'ROUTERS_OFFLINE', severity: 'WARNING', category: 'network', title: 'Routers offline', detail: `${routersOffline} router(s) are OFFLINE — subscribers on them cannot be provisioned.`, metrics: { routersOffline } });
  }
  if (outboxDead > 0) {
    signals.push({ code: 'OUTBOX_DEAD', severity: 'CRITICAL', category: 'reliability', title: 'Dead events in the outbox', detail: `${outboxDead} event(s) exhausted retries and are DEAD — downstream effects (notifications, projections) were lost.`, metrics: { outboxDead } });
  } else if (outboxPending > 200) {
    signals.push({ code: 'OUTBOX_BACKLOG', severity: 'WARNING', category: 'reliability', title: 'Event backlog building', detail: `${outboxPending} events are pending dispatch — the worker may be behind.`, metrics: { outboxPending } });
  }
  if (jobsFailed24 > 5) {
    signals.push({ code: 'JOB_FAILURES', severity: 'WARNING', category: 'reliability', title: 'Background jobs failing', detail: `${jobsFailed24} scheduled job(s) failed in the last 24h.`, metrics: { jobsFailed24 } });
  }

  // --- Billing: past-due ISPs (one insight per company) ---
  const pastDue = await prisma.tenant.findMany({ where: { planStatus: 'PAST_DUE' }, select: { id: true, name: true } });
  for (const t of pastDue) {
    signals.push({ code: 'TENANT_PAST_DUE', severity: 'WARNING', category: 'billing', title: `Company past due: ${t.name}`, detail: `${t.name} has an overdue platform subscription invoice.`, tenantId: t.id });
  }

  // --- Growth (informational) ---
  const newTenants = await prisma.tenant.count({ where: { createdAt: { gte: since7 }, id: { notIn: ['default', 'platform'] } } });
  if (newTenants > 0) {
    signals.push({ code: 'NEW_SIGNUPS', severity: 'INFO', category: 'growth', title: 'New companies onboarded', detail: `${newTenants} new company(ies) signed up in the last 7 days.`, metrics: { newTenants } });
  }

  // --- Persist (deduped) ---
  let created = 0;
  for (const s of signals) {
    const recent = await prisma.platformInsight.findFirst({
      where: {
        code: s.code,
        status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        createdAt: { gte: new Date(now.getTime() - DEDUPE_MS) },
        ...(s.tenantId !== undefined ? { tenantId: s.tenantId } : { tenantId: null }),
      },
      select: { id: true },
    });
    if (recent !== null) continue;
    await prisma.platformInsight.create({
      data: {
        code: s.code,
        severity: s.severity,
        category: s.category,
        title: s.title,
        detail: s.detail,
        ...(s.metrics !== undefined ? { metrics: s.metrics as Prisma.InputJsonValue } : {}),
        ...(s.tenantId !== undefined ? { tenantId: s.tenantId } : {}),
      },
    });
    created += 1;
  }

  const narrative = options.narrate ? await options.narrate(signals).catch(() => null) : null;
  return { signalsFound: signals.length, insightsCreated: created, narrative };
}
