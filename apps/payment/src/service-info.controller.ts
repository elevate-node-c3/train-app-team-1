import { Controller, Get } from '@nestjs/common';

@Controller('payment')
export class ServiceInfoController {
  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'payment', status: 'operational' };
  }
}
