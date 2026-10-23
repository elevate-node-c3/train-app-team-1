import { Injectable } from '@nestjs/common';
import { GatewayHealthService } from '@app/common';
import { AggregatedHealthReport } from '@app/contracts';
import { GatewayRepository } from '../persistence/gateway.repository.js';

@Injectable()
export class GatewayService {
  constructor(
    private readonly repository: GatewayRepository,
    private readonly gatewayHealthService: GatewayHealthService,
  ) {}

  async pingAll(): Promise<AggregatedHealthReport> {
    return this.gatewayHealthService.aggregate();
  }

  getInfo(): { service: string; version: string; description: string } {
    return {
      service: 'gateway',
      version: '0.0.1',
      description: 'API Gateway for train reservation platform',
    };
  }
}
