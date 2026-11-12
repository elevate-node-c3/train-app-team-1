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
 * The signed-in traveller's recent searches.
 *
 * A separate controller from `TripsGrpcController` because this is its own
 * feature with its own module, and the boundary rules put `@GrpcMethod` in a
 * `*.grpc.controller.ts`. Nest binds methods per handler, so two controllers
 * can serve one gRPC service.
 *
 * The traveller comes from caller metadata the gateway minted after verifying
 * a token, read here rather than in the service: the transport is where the
 * request's identity lives, and a service that reached into CLS itself could
 * not be tested without one. The request has no account field at all, so there
 * is nothing a client could put there.
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

    // Refused, not answered with an empty list. An empty list would say "you
    // have no recent searches", which is a claim about a traveller nobody
    // identified -- and it would hide a gateway that stopped forwarding the
    // caller.
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
