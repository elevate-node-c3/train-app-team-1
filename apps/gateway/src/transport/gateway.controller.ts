import { Controller, Get } from '@nestjs/common';
import { GatewayService } from '../domain/gateway.service.js';
import { AggregatedHealthReport } from '@app/contracts';

@Controller()
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  @Get()
  getRoot(): { service: string; version: string; description: string } {
    return this.gatewayService.getInfo();
  }

  @Get('api/ping-all')
  async pingAll(): Promise<AggregatedHealthReport> {
    return this.gatewayService.pingAll();
  }
}
