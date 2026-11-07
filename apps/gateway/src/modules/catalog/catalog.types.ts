import type { CallOptions } from '@grpc/grpc-js';
import type {
  GetTripStopsRequest,
  ListRecentSearchesRequest,
  ListRecentSearchesResponse,
  SearchOneWayTripsRequest,
  SearchOneWayTripsResponse,
  SearchReturnTripsRequest,
  SearchReturnTripsResponse,
  TripStopsResponse,
} from '@app/contracts';
import type { Observable } from 'rxjs';

/**
 * The catalog service as this gateway calls it.
 *
 * `metadata` and `options` are declared on every method so a deadline can be
 * threaded through the `ClientGrpc` proxy -- without them in the signature the
 * third argument has nowhere to go, and the call would wait forever.
 */
export interface CatalogGrpcClient {
  searchOneWayTrips(
    data: SearchOneWayTripsRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<SearchOneWayTripsResponse>;

  searchReturnTrips(
    data: SearchReturnTripsRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<SearchReturnTripsResponse>;

  getTripStops(
    data: GetTripStopsRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<TripStopsResponse>;

  listRecentSearches(
    data: ListRecentSearchesRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<ListRecentSearchesResponse>;
}

/** The resolved service proxy. */
export const CATALOG_GRPC_CLIENT = Symbol('CATALOG_GRPC_CLIENT');
