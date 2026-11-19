import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  CALLER_ACCOUNT_ID_KEY,
  GrpcCorrelationInterceptor,
  refusalException,
  toRpcException,
} from '@app/common';
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
      throw refusalException({ code: ErrorCode.UNAUTHORIZED, details: [] });
    }

    try {
      return await this.recentSearches.list(accountId, new Date());
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
