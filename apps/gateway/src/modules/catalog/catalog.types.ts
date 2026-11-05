import type { CallOptions } from '@grpc/grpc-js';
import type {
  SearchOneWayTripsRequest,
  SearchOneWayTripsResponse,
} from '@app/contracts';
import type { Observable } from 'rxjs';

/**
 * The catalog service as this gateway calls it.
 *
 * `metadata` and `options` are declared so a deadline can be threaded through
 * the `ClientGrpc` proxy -- without them in the signature the third argument
 * has nowhere to go, and the call would wait forever.
 */
export interface CatalogGrpcClient {
  searchOneWayTrips(
    data: SearchOneWayTripsRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<SearchOneWayTripsResponse>;
}

/** The resolved service proxy. */
export const CATALOG_GRPC_CLIENT = Symbol('CATALOG_GRPC_CLIENT');
