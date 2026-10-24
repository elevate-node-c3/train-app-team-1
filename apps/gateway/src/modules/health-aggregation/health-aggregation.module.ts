import { Module } from '@nestjs/common';
import { CommonModule, GatewayHealthService } from '@app/common';
import { SERVICE_HEALTH } from './application/ports/service-health.port.js';
import { HealthAggregationHttpController } from './presentation/http/health-aggregation.http.controller.js';

/**
 * Imports CommonModule for GatewayHealthService, which it re-exports from
 * HealthModule. A feature module declares its own imports rather than relying
 * on the root module having happened to import them.
 *
 * `GatewayHealthService` satisfies the port as it stands, so the adapter that
 * used to sit between them only forwarded a call of the same signature.
 */
@Module({
  imports: [CommonModule],
  controllers: [HealthAggregationHttpController],
  providers: [{ provide: SERVICE_HEALTH, useExisting: GatewayHealthService }],
})
export class HealthAggregationModule {}
