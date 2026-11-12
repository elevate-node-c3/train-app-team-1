import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { GrpcCorrelationInterceptor } from '@app/common';
import {
  INVENTORY_SERVICE_NAME,
  type SeatUsageForTripsRequest,
  type SeatUsageForTripsResponse,
} from '@app/contracts';

import { SeatUsageService } from './seat-usage.service.js';

/** Catalog's seam into whether a dated trip can be safely rewritten. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class SeatUsageGrpcController {
  constructor(private readonly seatUsage: SeatUsageService) {}

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'SeatUsageForTrips')
  async seatUsageForTrips(
    request: SeatUsageForTripsRequest,
  ): Promise<SeatUsageForTripsResponse> {
    const usages = await this.seatUsage.seatUsageForTrips(request.tripIds);
    return { usages };
  }
}
