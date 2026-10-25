import { Controller, Get, Inject } from '@nestjs/common';
import {
  AGGREGATE_READINESS,
  Public,
  type AggregateReadiness,
} from '@app/common';
import { AggregatedHealthReport } from '@app/contracts';

/**
 * The explicit aggregate route. `/health` answers the same report through the
 * library's controller; this one is the documented name for it.
 */
@Controller()
export class HealthAggregationHttpController {
  constructor(
    @Inject(AGGREGATE_READINESS)
    private readonly serviceHealth: AggregateReadiness,
  ) {}

  @Public()
  @Get('ping-all')
  async pingAll(): Promise<AggregatedHealthReport> {
    return this.serviceHealth.aggregate();
  }
}
