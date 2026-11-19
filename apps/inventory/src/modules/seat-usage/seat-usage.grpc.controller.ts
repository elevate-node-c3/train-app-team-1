import { Controller, UseInterceptors, UsePipes } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  createGrpcValidationPipe,
  GrpcCorrelationInterceptor,
  toRpcException,
} from '@app/common';
import {
  INVENTORY_SERVICE_NAME,
  type SeatUsageForTripsResponse,
} from '@app/contracts';
import { SeatUsageForTripsRequestDto } from './dto/seat-usage-request.dto.js';

import { SeatUsageService } from './seat-usage.service.js';

/** Seat counts let catalog reject unsafe trip rewrites. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UsePipes(createGrpcValidationPipe())
export class SeatUsageGrpcController {
  constructor(private readonly seatUsage: SeatUsageService) {}

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'SeatUsageForTrips')
  async seatUsageForTrips(
    request: SeatUsageForTripsRequestDto,
  ): Promise<SeatUsageForTripsResponse> {
    try {
      const usages = await this.seatUsage.seatUsageForTrips(request.tripIds);
      return { usages };
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
