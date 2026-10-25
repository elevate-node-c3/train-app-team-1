import { Module } from '@nestjs/common';
import { IdentityServices } from './identity.service.js';
import { IdentityController } from './identity.controller.js';

@Module({
  controllers: [IdentityController],
  providers: [IdentityServices],
})
export class IdentityModule {}
