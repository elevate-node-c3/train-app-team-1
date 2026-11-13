import { Controller, Get } from '@nestjs/common';

@Controller('inventory')
export class ServiceInfoController {
  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'inventory', status: 'operational' };
  }
}
