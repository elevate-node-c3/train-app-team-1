import { Controller, Get } from '@nestjs/common';
import { IdentityService } from '../domain/identity.service.js';

@Controller('identity')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Get()
  getInfo(): { service: string; status: string } {
    return this.identityService.getInfo();
  }
}
