import { Module } from '@nestjs/common';
import { AuthController } from './controllers/auth.controller.js';
import { PassengersController } from './controllers/passengers.controller.js';
import { ProfileController } from './controllers/profile.controller.js';
import { StaffController } from './controllers/staff.controller.js';
import { IdentityGrpcClient } from './identity.grpc.client.js';
import { IdentityService } from './identity.service.js';

/** Guards and security stores belong to common/security, not this feature. */
@Module({
  controllers: [
    AuthController,
    PassengersController,
    ProfileController,
    StaffController,
  ],
  providers: [IdentityGrpcClient, IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
