import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { CALLER_ACCOUNT_ID_KEY, GrpcCorrelationInterceptor } from '@app/common';
import { ClsService } from 'nestjs-cls';
import {
  CATALOG_SERVICE_NAME,
  ErrorCode,
  type ListRecentSearchesResponse,
} from '@app/contracts';

import { RecentSearchesService } from './recent-searches.service.js';

/**
 * Read gateway-verified caller metadata at the transport boundary; account IDs
 * are never client-supplied, and services do not read CLS.
 * Keep gRPC handlers in *.grpc.controller.ts; separate controllers can serve one service.
 */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class RecentSearchesGrpcController {
  constructor(
    private readonly recentSearches: RecentSearchesService,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(CATALOG_SERVICE_NAME, 'ListRecentSearches')
  async listRecentSearches(): Promise<ListRecentSearchesResponse> {
    const accountId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);

    // Refuse missing identity; an empty list would hide a gateway metadata failure.
    if (!accountId) {
      throw new RpcException({
        code: grpc.status.UNAUTHENTICATED,
        details: JSON.stringify({ code: ErrorCode.UNAUTHORIZED, details: [] }),
        message: 'Recent searches require a signed-in traveller',
      });
    }

    return this.recentSearches.list(accountId, new Date());
  }
}
