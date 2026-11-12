import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { GrpcCorrelationInterceptor } from '@app/common';
import {
  INVENTORY_SERVICE_NAME,
  type SeatUsageForTripsRequest,
  type SeatUsageForTripsResponse,
} from '@app/contracts';

import { SeatUsageService } from './seat-usage.service.js';

/** Seat counts let catalog reject unsafe trip rewrites. */
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
