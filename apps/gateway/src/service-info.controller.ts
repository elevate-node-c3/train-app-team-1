import { Controller, Get } from '@nestjs/common';
import { Public } from '@app/common';

@Controller()
export class ServiceInfoController {
  @Public()
  @Get()
  getRoot(): { service: string; version: string; description: string } {
    return {
      service: 'gateway',
      version: '0.0.1',
      description: 'API Gateway for train reservation platform',
    };
  }
}
