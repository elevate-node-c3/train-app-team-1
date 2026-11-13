import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { ListStationsRequest, ListStationsResponse } from '@app/contracts';
import { GrpcCorrelationInterceptor } from '@app/common';
import { StationsService } from './stations.service.js';
import { toRpcException } from '../trips/to-rpc-exception.js';

/** The gRPC transport adapter: no business rule, one call to the service. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class StationsGrpcController {
  constructor(private readonly stations: StationsService) {}

  @GrpcMethod('CatalogService', 'ListStations')
  async listStations(
    request: ListStationsRequest,
  ): Promise<ListStationsResponse> {
    try {
      return await this.stations.listStationGroups(
        request.language,
        request.query,
      );
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
