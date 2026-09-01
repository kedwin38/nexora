/**
 * Wire-level API contracts shared between apps/web and apps/api.
 */

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
  };
}

export interface PaginationQuery {
  readonly page?: number;
  readonly limit?: number;
}

export interface PaginatedBody<T> {
  readonly data: T[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface HealthLiveBody {
  readonly status: 'ok';
  readonly service: string;
  readonly uptimeSeconds: number;
}

export type DependencyStatus = 'up' | 'down' | 'not_configured';

export interface HealthReadyBody {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly dependencies: Record<string, { readonly status: DependencyStatus }>;
  readonly checkedAt: string;
}
