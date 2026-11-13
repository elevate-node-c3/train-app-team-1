import { Controller, Get } from '@nestjs/common';

@Controller('identity')
export class ServiceInfoController {
  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'identity', status: 'operational' };
  }
}
