import type { CallOptions } from '@grpc/grpc-js';
import type { Observable } from 'rxjs';

export interface HealthGrpcResponse {
  status: number;
  service: string;
  message: string;
  details: Record<string, string>;
}

export interface HealthGrpcClient {
  check(
    data: { service: string },
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<HealthGrpcResponse>;
}

/** The resolved service proxies, injected as one ready map. */
export const HEALTH_GRPC_CLIENTS = Symbol('HEALTH_GRPC_CLIENTS');
