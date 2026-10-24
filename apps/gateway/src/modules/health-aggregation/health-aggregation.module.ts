import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { AggregateHealthUseCase } from './application/aggregate-health.use-case.js';
import { SERVICE_HEALTH } from './application/ports/service-health.port.js';
import { GatewayHealthAdapter } from './infrastructure/grpc/gateway-health.adapter.js';
import { HealthAggregationHttpController } from './presentation/http/health-aggregation.http.controller.js';

/**
 * Imports CommonModule for GatewayHealthService, which it re-exports from
 * HealthModule. A feature module declares its own imports rather than relying
 * on the root module having happened to import them.
 */
@Module({
  imports: [CommonModule],
  controllers: [HealthAggregationHttpController],
  providers: [
    AggregateHealthUseCase,
    { provide: SERVICE_HEALTH, useClass: GatewayHealthAdapter },
  ],
})
export class HealthAggregationModule {}
