import { Module } from '@nestjs/common';

import { SeatUsageGrpcController } from './seat-usage.grpc.controller.js';
import { SeatUsageService } from './seat-usage.service.js';

/** Answers catalog's seat-usage question over gRPC (TA-20). */
@Module({
  controllers: [SeatUsageGrpcController],
  providers: [SeatUsageService],
})
export class SeatUsageModule {}
