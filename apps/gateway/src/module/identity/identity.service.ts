import { Metadata, type ServerUnaryCall } from '@grpc/grpc-js';
import { Controller, Inject, OnModuleInit } from '@nestjs/common';
import {
  IConfirmEmailRequest,
  IForgetPasswordRequest,
  IIdentityGrpcServices,
  ILoginRequest,
  ILogout,
  IRefreshRequest,
  IResendOTPRequest,
  IResetPassword,
  ISignUpRequest,
} from '../../common/interface/identityService.interface.js';
import { type ClientGrpc } from '@nestjs/microservices';

@Controller('identity')
export class IdentityServices implements OnModuleInit {
  private identityService: IIdentityGrpcServices;
  constructor(@Inject('IDENTITY_PACKAGE') private identityClient: ClientGrpc) {}

  onModuleInit() {
    this.identityService =
      this.identityClient.getService<IIdentityGrpcServices>('IdentityService');
  }

  async signUp(data: ISignUpRequest) {
    return this.identityService.signUp(data);
  }
  async signIn(data: ILoginRequest) {
    return this.identityService.signIn(data);
  }
  async confirmEmail(data: IConfirmEmailRequest) {
    return this.identityService.confirmEmail(data);
  }
  async resendOTP(data: IResendOTPRequest) {
    return this.identityService.resendOTP(data);
  }
  async refresh(data: IRefreshRequest) {
    return this.identityService.refresh(data);
  }
  async forgetPassword(data: IForgetPasswordRequest) {
    return this.identityService.forgetPassword(data);
  }
  async resetPassword(data: IResetPassword) {
    return this.identityService.resetPassword(data);
  }
  async logout(data: ILogout) {
    return this.identityService.logout(data);
  }
}
