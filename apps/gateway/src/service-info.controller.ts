import { Controller, Get } from '@nestjs/common';
import { Public } from '@app/common';

/** The platform's root endpoint. A constant needs no layers. */
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
