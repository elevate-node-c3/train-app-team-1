import { Controller, Get, Inject } from '@nestjs/common';
import {
  AGGREGATE_READINESS,
  Public,
  type AggregateReadiness,
} from '@app/common';
import { AggregatedHealthReport } from '@app/contracts';

/** Returns the same aggregate report as the shared /health route. */
@Controller()
export class HealthController {
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
