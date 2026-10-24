import { Controller, Get } from '@nestjs/common';
import type { ServiceInfo } from '../../application/service-info.service.js';
import { ServiceInfoService } from '../../application/service-info.service.js';

@Controller('booking')
export class ServiceInfoHttpController {
  constructor(private readonly serviceInfo: ServiceInfoService) {}

  @Get()
  getInfo(): ServiceInfo {
    return this.serviceInfo.getInfo();
  }
}
