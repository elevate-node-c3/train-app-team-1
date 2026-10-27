import { Module } from '@nestjs/common';
import { AuthController } from './controllers/auth.controller.js';
import { StaffController } from './controllers/staff.controller.js';
import { IdentityGrpcClient } from './identity.grpc.client.js';
import { IdentityService } from './identity.service.js';

/**
 * The gateway's identity feature: the public auth surface and the one gRPC
 * client it calls. Guards and security stores belong to `common/security`.
 */
@Module({
  controllers: [AuthController, StaffController],
  providers: [IdentityGrpcClient, IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
