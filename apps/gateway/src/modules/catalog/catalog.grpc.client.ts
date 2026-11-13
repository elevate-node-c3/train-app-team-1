import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { createGrpcMetadataWithCaller, grpcStatusException } from '@app/common';
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
  StationResponse,
  TripStopsResponse,
  UpdateStationRequest,
} from '@app/contracts';

import {
  CATALOG_GRPC_CLIENT,
  type CatalogGrpcClient,
} from './catalog.types.js';
import { parseCatalogBusinessError } from './catalog-error.js';

/** Bound search waits so a stopped catalog returns a retryable error. */
export const CATALOG_SEARCH_TIMEOUT_MS = 3000;

@Injectable()
export class CatalogGrpcClientService {
  private readonly logger = new Logger(CatalogGrpcClientService.name);

  constructor(
    @Inject(CATALOG_GRPC_CLIENT)
    private readonly client: CatalogGrpcClient,
    private readonly cls: ClsService,
  ) {}

  async listStations(
    request: ListStationsRequest,
  ): Promise<ListStationsResponse> {
    return this.call((client, metadata, options) =>
      client.listStations(request, metadata, options),
    );
  }

  async getStation(stationId: string): Promise<StationResponse> {
    return this.call((client, metadata, options) =>
      client.getStation({ stationId }, metadata, options),
    );
  }

  async createStation(
    request: CreateStationRequest,
    idempotencyKey: string,
  ): Promise<StationResponse> {
    return this.call((client, metadata, options) => {
      metadata.set('idempotency-key', idempotencyKey);
      return client.createStation(request, metadata, options);
    });
  }

  async updateStation(
    request: UpdateStationRequest,
    idempotencyKey: string,
  ): Promise<StationResponse> {
    return this.call((client, metadata, options) => {
      metadata.set('idempotency-key', idempotencyKey);
      return client.updateStation(request, metadata, options);
    });
  }

  async deactivateStation(
    stationId: string,
    idempotencyKey: string,
  ): Promise<StationResponse> {
    return this.call((client, metadata, options) => {
      metadata.set('idempotency-key', idempotencyKey);
      return client.deactivateStation({ stationId }, metadata, options);
    });
  }

  async searchOneWayTrips(
    request: SearchOneWayTripsRequest,
  ): Promise<SearchOneWayTripsResponse> {
    return this.call((client, metadata, options) =>
      client.searchOneWayTrips(request, metadata, options),
    );
  }

  async searchReturnTrips(
    request: SearchReturnTripsRequest,
  ): Promise<SearchReturnTripsResponse> {
    return this.call((client, metadata, options) =>
      client.searchReturnTrips(request, metadata, options),
    );
  }

  async getTripStops(request: GetTripStopsRequest): Promise<TripStopsResponse> {
    return this.call((client, metadata, options) =>
      client.getTripStops(request, metadata, options),
    );
  }

  async listRecentSearches(
    request: ListRecentSearchesRequest,
  ): Promise<ListRecentSearchesResponse> {
    return this.call((client, metadata, options) =>
      client.listRecentSearches(request, metadata, options),
    );
  }

  /**
   * Share caller metadata, deadlines, and error mapping across every RPC.
   * RxJS also times out channels that never emit a gRPC deadline error.
   */
  private async call<T>(
    invoke: (
      client: CatalogGrpcClient,
      metadata: Metadata,
      options: { deadline: number },
    ) => Observable<T>,
  ): Promise<T> {
    const metadata = createGrpcMetadataWithCaller(this.cls);
    const deadline = Date.now() + CATALOG_SEARCH_TIMEOUT_MS;

    try {
      return await firstValueFrom(
        invoke(this.client, metadata, { deadline }).pipe(
          timeout(CATALOG_SEARCH_TIMEOUT_MS + 500),
        ),
      );
    } catch (error: unknown) {
      throw this.toHttpError(error);
    }
  }

  /** Prefer business errors; transport failures get shared status and retry hints. */
  private toHttpError(error: unknown): unknown {
    const business = parseCatalogBusinessError(error);
    if (business) return business;

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      this.logger.warn(`Catalog search failed with gRPC status ${code}`);
      return grpcStatusException(code);
    }

    // Map local RxJS timeouts to deadline errors, not 500s.
    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn('Catalog search exceeded its deadline locally');
      return grpcStatusException(4); // DEADLINE_EXCEEDED
    }

    return error;
  }
}
