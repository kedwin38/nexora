/**
 * Global error handling: NexoraError taxonomy -> structured JSON envelope.
 * Stack traces and internals never reach clients (§52; persona §8).
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NexoraError, newCorrelationId } from '@nexora/domain';
import type { ApiErrorBody } from '@nexora/contracts';
import type { Logger } from '@nexora/logging';

export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = request.id;
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} does not exist.`,
        correlationId,
        retryable: false,
      },
    } satisfies ApiErrorBody);
  });

  app.setErrorHandler((error: FastifyError | NexoraError | Error, request, reply) => {
    const correlationId = request.id || newCorrelationId();

    if (error instanceof NexoraError) {
      const status = mapCodeToStatus(error.code);
      return reply.status(status).send({
        error: { ...error.toJSON(), correlationId: error.correlationId ?? correlationId },
      } satisfies ApiErrorBody);
    }

    // Fastify validation errors
    if ('validation' in error && error.validation !== undefined) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: error.message,
          correlationId,
          retryable: false,
        },
      } satisfies ApiErrorBody);
    }

    if ('statusCode' in error && typeof error.statusCode === 'number') {
      return reply.status(error.statusCode).send({
        error: {
          code: 'HTTP_ERROR',
          message: error.message,
          correlationId,
          retryable: false,
        },
      } satisfies ApiErrorBody);
    }

    logger.error('Unhandled error', { correlationId, method: request.method, url: request.url });
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
        correlationId,
        retryable: false,
      },
    } satisfies ApiErrorBody);
  });
}

function mapCodeToStatus(code: string): number {
  switch (code) {
    case 'VALIDATION_FAILED':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'INVALID_STATE_TRANSITION':
      return 409;
    default:
      return 500;
  }
}
