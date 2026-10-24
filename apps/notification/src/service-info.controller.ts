import { Controller, Get } from '@nestjs/common';

/** The service's identity endpoint. A constant needs no layers. */
@Controller('notification')
export class ServiceInfoController {
  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'notification', status: 'operational' };
  }
}
