import { Controller, Get } from '@nestjs/common';

/** The service's identity endpoint. A constant needs no layers. */
@Controller('inventory')
export class ServiceInfoController {
  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'inventory', status: 'operational' };
  }
}
