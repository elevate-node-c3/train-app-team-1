import type { CallOptions } from '@grpc/grpc-js';
import type {
  CreateStationRequest,
  GetTripStopsRequest,
  ListRecentSearchesRequest,
  ListRecentSearchesResponse,
  ListStationsRequest,
  ListStationsResponse,
  SearchOneWayTripsRequest,
  SearchOneWayTripsResponse,
  SearchReturnTripsRequest,
  SearchReturnTripsResponse,
  StationIdRequest,
  StationResponse,
  TripStopsResponse,
  UpdateStationRequest,
} from '@app/contracts';
import type { Observable } from 'rxjs';

/** Proxy methods include metadata and options so every call can carry a deadline. */
export interface CatalogGrpcClient {
  listStations(
    data: ListStationsRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<ListStationsResponse>;

  getStation(
    data: StationIdRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<StationResponse>;

  createStation(
    data: CreateStationRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<StationResponse>;

  updateStation(
    data: UpdateStationRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<StationResponse>;

  deactivateStation(
    data: StationIdRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<StationResponse>;

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

export const CATALOG_GRPC_CLIENT = Symbol('CATALOG_GRPC_CLIENT');
