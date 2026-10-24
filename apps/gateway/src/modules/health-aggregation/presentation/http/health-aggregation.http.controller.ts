import { Controller, Get, Inject } from '@nestjs/common';
import { AggregatedHealthReport } from '@app/contracts';
import {
  SERVICE_HEALTH,
  type ServiceHealthPort,
} from '../../application/ports/service-health.port.js';

/**
 * Injects the port, not a use-case: there is no aggregation rule here beyond
 * the fan-out itself, which the implementation owns.
 */
@Controller('api')
export class HealthAggregationHttpController {
  constructor(
    @Inject(SERVICE_HEALTH) private readonly serviceHealth: ServiceHealthPort,
  ) {}

  @Get('ping-all')
  async pingAll(): Promise<AggregatedHealthReport> {
    return this.serviceHealth.aggregate();
  }
}
