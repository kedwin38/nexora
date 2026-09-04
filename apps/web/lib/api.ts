'use client';

// Same-origin API client — Next rewrites /api/* to the API service.

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
}

export class ApiCallError extends Error {
  public readonly code: string;
  constructor(error: ApiError) {
    super(error.message);
    this.code = error.code;
  }
}

const store = {
  get: (k: string): string | null => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(`nexora_${k}`);
  },
  set: (k: string, v: string): void => window.localStorage.setItem(`nexora_${k}`, v),
  del: (k: string): void => window.localStorage.removeItem(`nexora_${k}`),
};

export const session = {
  token: (kind: 'user' | 'customer'): string | null => store.get(`${kind}_token`),
  signIn: (kind: 'user' | 'customer', token: string): void => store.set(`${kind}_token`, token),
  signOut: (): void => {
    store.del('user_token');
    store.del('customer_token');
  },
};

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = session.token('user') ?? session.token('customer');
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: ApiError };
  if (!response.ok) {
    // Non-JSON 500 = the Next.js proxy itself failed (API unreachable) —
    // almost always a missing/wrong API_PROXY_URL on the web service.
    if (response.status === 500 && body.error === undefined) {
      throw new ApiCallError({
        code: 'API_UNREACHABLE',
        message: 'API service unreachable — check API_PROXY_URL on the web service and that the api service is deployed.',
        correlationId: '',
      });
    }
    throw new ApiCallError(body.error ?? { code: 'UNKNOWN', message: `HTTP ${response.status}`, correlationId: '' });
  }
  return body;
}

export function fmtKes(minor: number): string {
  return `KES ${(Number(minor) / 100).toFixed(2)}`;
}

export function fmtBytes(bytes: string | number | null): string {
  const value = Number(bytes ?? 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)}MB`;
  return `${value}B`;
}
