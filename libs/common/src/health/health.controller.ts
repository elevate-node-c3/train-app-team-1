import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { AggregatedHealthReport, ServiceHealthReport } from '@app/contracts';
import {
  AGGREGATE_READINESS,
  type AggregateReadiness,
} from './aggregate-readiness.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    // Unbound in six of seven services, which is what makes this a local
    // report for them without the controller knowing where it runs.
    @Optional()
    @Inject(AGGREGATE_READINESS)
    private readonly aggregate?: AggregateReadiness,
  ) {}

  @Get('live')
  live(): { status: 'live'; timestamp: string } {
    return this.healthService.checkLiveness();
  }

  @Get('ready')
  async ready(): Promise<ServiceHealthReport | AggregatedHealthReport> {
    return this.aggregate
      ? this.aggregate.aggregate()
      : this.healthService.checkReadiness();
  }

  @Get()
  async health(): Promise<ServiceHealthReport | AggregatedHealthReport> {
    return this.ready();
  }
}
