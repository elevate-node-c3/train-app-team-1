import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout } from 'rxjs';
import { createGrpcMetadataWithCaller, grpcStatusException } from '@app/common';
import type {
  SearchOneWayTripsRequest,
  SearchOneWayTripsResponse,
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
    const metadata = createGrpcMetadataWithCaller(this.cls);

    // Belt and braces, and the rxjs timeout is not redundant: the deadline is
    // enforced by the gRPC channel, and the operator covers the case where the
    // channel never produces a deadline event at all. Either way the request
    // ends.
    const deadline = Date.now() + CATALOG_SEARCH_TIMEOUT_MS;

    try {
      return await firstValueFrom(
        this.client
          .searchOneWayTrips(request, metadata, { deadline })
          .pipe(timeout(CATALOG_SEARCH_TIMEOUT_MS + 500)),
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
