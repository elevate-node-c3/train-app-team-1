import { Controller, Get } from '@nestjs/common';

@Controller('notification')
export class ServiceInfoController {
  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'notification', status: 'operational' };
  }
}
