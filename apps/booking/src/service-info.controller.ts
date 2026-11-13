import { Controller, Get } from '@nestjs/common';

@Controller('booking')
export class ServiceInfoController {
  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'booking', status: 'operational' };
  }
}
