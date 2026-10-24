import { Module } from '@nestjs/common';
import { MessagingModule } from '@app/messaging';
import { GracefulShutdownService } from '../shutdown/graceful-shutdown.service.js';
import { RedisHealthService } from './redis-health.service.js';
import { HealthService } from './health.service.js';
import { HealthController } from './health.controller.js';
import { HealthGrpcController } from './health.grpc.controller.js';
import { GatewayHealthService } from './gateway-health.service.js';

@Module({
  imports: [MessagingModule],
  controllers: [HealthController, HealthGrpcController],
  providers: [
    GracefulShutdownService,
    RedisHealthService,
    HealthService,
    GatewayHealthService,
  ],
  exports: [
    GracefulShutdownService,
    RedisHealthService,
    HealthService,
    GatewayHealthService,
  ],
})
export class HealthModule {}
