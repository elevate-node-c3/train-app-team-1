import { Controller, Get } from '@nestjs/common';
import { AggregatedHealthReport } from '@app/contracts';
import { AggregateHealthUseCase } from '../../application/aggregate-health.use-case.js';

@Controller('api')
export class HealthAggregationHttpController {
  constructor(private readonly aggregateHealth: AggregateHealthUseCase) {}

  @Get('ping-all')
  async pingAll(): Promise<AggregatedHealthReport> {
    return this.aggregateHealth.execute();
  }
}
