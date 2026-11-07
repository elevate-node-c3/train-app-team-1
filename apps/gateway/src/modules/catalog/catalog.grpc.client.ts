import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { createGrpcMetadataWithCaller, grpcStatusException } from '@app/common';
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

import {
  CATALOG_GRPC_CLIENT,
  type CatalogGrpcClient,
} from './catalog.types.js';
import { parseCatalogBusinessError } from './catalog-error.js';

/**
 * How long the gateway waits for a search.
 *
 * Longer than identity's 2500ms because search does real query work, and short
 * enough that a traveller watching a spinner gets an answer either way. The
 * point is not the number: it is that there IS one, so a slow or stopped
 * catalog produces a retryable error instead of a request that never returns.
 */
export const CATALOG_SEARCH_TIMEOUT_MS = 3000;

@Injectable()
export class CatalogGrpcClientService {
  private readonly logger = new Logger(CatalogGrpcClientService.name);

  constructor(
    @Inject(CATALOG_GRPC_CLIENT)
    private readonly client: CatalogGrpcClient,
    private readonly cls: ClsService,
  ) {}

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

  async getTripStops(
    request: GetTripStopsRequest,
  ): Promise<TripStopsResponse> {
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
   * One call to catalog: caller metadata in, a deadline on it, errors mapped.
   *
   * Every method goes through here rather than repeating the four lines. The
   * deadline is the point -- a slow or stopped catalog has to produce a
   * retryable error rather than a request that never returns -- and a method
   * that forgot it would be invisible until production.
   *
   * The rxjs timeout is not redundant with the channel deadline: the deadline
   * is enforced by gRPC, and the operator covers the case where the channel
   * never produces a deadline event at all. Either way the request ends.
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

  /**
   * A business refusal first, then the transport status.
   *
   * Catalog's validation refusals arrive as INVALID_ARGUMENT with the real
   * code and the field details in `details`. Anything else -- a deadline, an
   * unavailable channel -- is categorised by `grpcStatusException`, which
   * already maps DEADLINE_EXCEEDED to 504 and UNAVAILABLE to 503, both with a
   * retry hint. Those two ARE the "search unavailable, try again" response the
   * story asks for, and both already have Arabic and English sentences.
   */
  private toHttpError(error: unknown): unknown {
    const business = parseCatalogBusinessError(error);
    if (business) return business;

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      this.logger.warn(`Catalog search failed with gRPC status ${code}`);
      return grpcStatusException(code);
    }

    // An rxjs TimeoutError, which has no gRPC status: report it as the
    // deadline it is rather than letting it become a 500.
    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn('Catalog search exceeded its deadline locally');
      return grpcStatusException(4); // DEADLINE_EXCEEDED
    }

    return error;
  }
}
