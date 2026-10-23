import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';
import { GatewayHealthService } from './gateway-health.service.js';
import { AggregatedHealthReport, ServiceHealthReport } from '@app/contracts';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly gatewayHealthService: GatewayHealthService,
  ) {}

  @Get('live')
  live(): { status: 'live'; timestamp: string } {
    return this.healthService.checkLiveness();
  }

  @Get('ready')
  async ready(): Promise<ServiceHealthReport | AggregatedHealthReport> {
    if (process.env.APP === 'gateway') {
      return this.gatewayHealthService.aggregate();
    }
    return this.healthService.checkReadiness();
  }

  @Get()
  async health(): Promise<ServiceHealthReport | AggregatedHealthReport> {
    return this.ready();
  }
}
