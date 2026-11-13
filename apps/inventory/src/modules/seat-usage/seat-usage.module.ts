import { Module } from '@nestjs/common';

import { SeatsModule } from '../seats/seats.module.js';
import { SeatUsageGrpcController } from './seat-usage.grpc.controller.js';
import { SeatUsageService } from './seat-usage.service.js';

/** Report inventory seat usage to catalog over gRPC. */
@Module({
  imports: [SeatsModule],
  controllers: [SeatUsageGrpcController],
  providers: [SeatUsageService],
})
export class SeatUsageModule {}
