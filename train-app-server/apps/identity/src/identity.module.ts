import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';

@Module({
  imports: [],
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityModule {}
