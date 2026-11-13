import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { ClsService } from 'nestjs-cls';
import { CALLER_ACCOUNT_ID_KEY, GrpcCorrelationInterceptor } from '@app/common';
import { CATALOG_SERVICE_NAME, ErrorCode, type CreateStationRequest, type StationIdRequest, type StationResponse, type UpdateStationRequest, type ValidationIssueRef } from '@app/contracts';
import { CatalogSearchError } from '../trips/catalog-search-error.js';
import { toRpcException } from '../trips/to-rpc-exception.js';
import { StationsManagementService } from './stations-management.service.js';

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class StationsManagementGrpcController {
  constructor(private readonly management: StationsManagementService, private readonly cls: ClsService) {}

  @GrpcMethod(CATALOG_SERVICE_NAME, 'GetStation')
  async getStation(request: StationIdRequest): Promise<StationResponse> {
    try { return await this.management.get(request.stationId); }
    catch (error: unknown) { throw toRpcException(error); }
  }

  @GrpcMethod(CATALOG_SERVICE_NAME, 'CreateStation')
  async createStation(request: CreateStationRequest, metadata?: Metadata): Promise<StationResponse> {
    try {
      const { key, actor } = this.requireActor(metadata);
      return await this.management.create(request, key, actor);
    } catch (error: unknown) { throw toRpcException(error); }
  }

  @GrpcMethod(CATALOG_SERVICE_NAME, 'UpdateStation')
  async updateStation(request: UpdateStationRequest, metadata?: Metadata): Promise<StationResponse> {
    try {
      const { key, actor } = this.requireActor(metadata);
      return await this.management.update(request, key, actor);
    } catch (error: unknown) { throw toRpcException(error); }
  }

  @GrpcMethod(CATALOG_SERVICE_NAME, 'DeactivateStation')
  async deactivateStation(request: StationIdRequest, metadata?: Metadata): Promise<StationResponse> {
    try {
      const { key, actor } = this.requireActor(metadata);
      return await this.management.deactivate(request.stationId, key, actor);
    } catch (error: unknown) { throw toRpcException(error); }
  }

  private requireActor(metadata?: Metadata): { key: string; actor: string } {
    const actor = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
    const value = metadata?.get('idempotency-key')[0];
    const key = typeof value === 'string' ? value.trim() : undefined;
    const details: ValidationIssueRef[] = [];
    if (!actor) details.push({ field: 'callerAccountId', rejectedValue: undefined, issueKey: 'ISSUE_CALLER_ACCOUNT_MISSING', actionKey: 'ACTION_SIGN_IN_AND_RETRY' });
    if (!key) details.push({ field: 'Idempotency-Key', rejectedValue: value, issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED', actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY' });
    if (details.length) throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, details);
    return { key: key!, actor: actor! };
  }
}
