import { Module } from '@nestjs/common';
import { RedisModule } from '../cache/redis.module.js';
import { GracefulShutdownService } from '../shutdown/graceful-shutdown.service.js';
import { RedisHealthService } from './redis-health.service.js';
import { HealthService } from './health.service.js';
import { HealthController } from './health.controller.js';
import { HealthGrpcController } from './health.grpc.controller.js';
import { HealthRegistryModule } from './health-registry.module.js';

@Module({
  imports: [HealthRegistryModule, RedisModule],
  controllers: [HealthController, HealthGrpcController],
  providers: [
    GracefulShutdownService,
    RedisHealthService,
    HealthService,
  ],
  exports: [
    GracefulShutdownService,
    RedisHealthService,
    HealthService,
  ],
})
export class HealthModule {}
