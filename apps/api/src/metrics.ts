/**
 * Prometheus metrics (§50) — prom-client, /metrics endpoint.
 *
 * HTTP histogram is recorded per request; business counters are incremented
 * at mutation sites; gauges collect DB counts on scrape.
 */

import { Gauge, Histogram, Counter, Registry, collectDefaultMetrics } from 'prom-client';
import type { PrismaClient } from '@prisma/client';

export interface ApiMetrics {
  readonly registry: Registry;
  httpRequestDuration: (labels: { method: string; route: string; status: number }, seconds: number) => void;
  paymentOutcome: (status: 'initiated' | 'confirmed' | 'failed') => void;
}

export function createMetrics(prisma: PrismaClient): ApiMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'nexora_' });

  const httpDuration = new Histogram({
    name: 'nexora_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const payments = new Counter({
    name: 'nexora_payments_total',
    help: 'Payment lifecycle outcomes',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  new Gauge({
    name: 'nexora_active_sessions',
    help: 'Customer sessions currently ONLINE/THROTTLED',
    registers: [registry],
    async collect() {
      const count = await prisma.customerSession.count({
        where: { status: { in: ['ONLINE', 'THROTTLED'] } },
      });
      this.set(count);
    },
  });

  new Gauge({
    name: 'nexora_active_subscriptions',
    help: 'Subscriptions ACTIVE or FUP',
    registers: [registry],
    async collect() {
      const count = await prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'FUP'] } } });
      this.set(count);
    },
  });

  new Gauge({
    name: 'nexora_network_operations_queued',
    help: 'Network operations awaiting execution',
    registers: [registry],
    async collect() {
      const count = await prisma.networkOperation.count({
        where: { status: { in: ['QUEUED', 'RETRYING', 'PROCESSING', 'VERIFYING'] } },
      });
      this.set(count);
    },
  });

  return {
    registry,
    httpRequestDuration: (labels, seconds) => httpDuration.observe(labels, seconds),
    paymentOutcome: (outcome) => payments.inc({ outcome }),
  };
}
