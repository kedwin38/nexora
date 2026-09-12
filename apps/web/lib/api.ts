'use client';

// Same-origin API client — Next rewrites /api/* to the API service.

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
}

export class ApiCallError extends Error {
  public readonly code: string;
  public readonly status: number;
  constructor(error: ApiError, status = 0) {
    super(error.message);
    this.code = error.code;
    this.status = status;
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
      }, 500);
    }
    throw new ApiCallError(body.error ?? { code: 'UNKNOWN', message: `HTTP ${response.status}`, correlationId: '' }, response.status);
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

export function fmtDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString();
}

export function fmtWhen(iso: string | null): string {
  if (iso === null) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---- Staff identity + permissions (from /auth/me) ------------------------

export interface Me {
  user: { id: string; email: string; displayName: string | null; role: string; tenantId: string };
  tenant: { id: string; name: string; slug: string; status: string };
  permissions: string[];
}

let meCache: Me | null = null;

/** Fetch (and cache) the signed-in staff identity, or null if not signed in. */
export async function getMe(force = false): Promise<Me | null> {
  if (session.token('user') === null) {
    meCache = null;
    return null;
  }
  if (meCache !== null && !force) return meCache;
  try {
    meCache = await api<Me>('/api/v1/auth/me');
    return meCache;
  } catch {
    meCache = null;
    return null;
  }
}

export function clearMe(): void {
  meCache = null;
}

export function can(me: Me | null, permission: string): boolean {
  return me !== null && me.permissions.includes(permission);
}

export function isOwner(me: Me | null): boolean {
  return me !== null && me.user.role === 'PLATFORM_OWNER';
}

/** Best-effort server-side token revoke, then clear local state and redirect. */
export async function logout(): Promise<void> {
  try {
    await api('/api/v1/auth/logout', { method: 'POST' });
  } catch {
    // ignore — clear locally regardless
  }
  session.signOut();
  clearMe();
  if (typeof window !== 'undefined') window.location.href = '/auth/login';
}
