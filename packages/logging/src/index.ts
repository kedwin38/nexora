/**
 * Structured logging.
 *
 * JSON in production, pretty-printed in development. Secrets are redacted at
 * the serializer level so no call site can leak them accidentally. Every log
 * line carries the service name and (when bound) a correlation ID.
 */

import { pino, type Logger as PinoLogger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  fatal(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  trace(message: string, meta?: Record<string, unknown>): void;
}

const REDACT_PATHS = [
  'password',
  'passwordHash',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'passkey',
  'consumerSecret',
  'sessionSecret',
  'req.headers.authorization',
  'req.headers.cookie',
];

function log(
  instance: PinoLogger,
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> | undefined,
): void {
  if (meta === undefined) {
    instance[level](message);
  } else {
    instance[level](meta, message);
  }
}

function toLogger(instance: PinoLogger): Logger {
  return {
    child: (bindings: Record<string, unknown>): Logger => toLogger(instance.child(bindings)),
    fatal: (message, meta) => log(instance, 'fatal', message, meta),
    error: (message, meta) => log(instance, 'error', message, meta),
    warn: (message, meta) => log(instance, 'warn', message, meta),
    info: (message, meta) => log(instance, 'info', message, meta),
    debug: (message, meta) => log(instance, 'debug', message, meta),
    trace: (message, meta) => log(instance, 'trace', message, meta),
  };
}

export function createLogger(options: {
  service: string;
  level: LogLevel;
  pretty?: boolean;
  bindings?: Record<string, unknown>;
}): Logger {
  const pretty = options.pretty ?? process.env.NODE_ENV === 'development';
  const instance = pino({
    level: options.level,
    base: { service: options.service, ...options.bindings },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });

  return toLogger(instance);
}
