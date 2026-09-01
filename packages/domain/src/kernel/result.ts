/**
 * Result type for fallible operations whose failures are part of the domain
 * (expected control flow) rather than exceptional. Infrastructure failures
 * (bugs, unreachable dependencies) should still throw.
 */

import type { NexoraError } from './errors.js';

export type Result<T, E = NexoraError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Maps the success channel, leaving the error channel untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
