import {
  Body,
  Controller,
  Get,
  Injectable,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { IdentityServices } from './identity.service.js';
import { SignUpRequest } from './validation/SignUpRequest.dto.js';
import { SignInRequest } from './validation/SignInRequest.dto.js';
import { ConfirmEmailRequest } from './validation/ConfirmEmailRequest.dto.js';
import { ResendOTPRequest } from './validation/ResendOTPRequest.dto.js';
import { RefreshRequest } from './validation/RefreshRequest.dto.js';
import { ForgetPasswordRequest } from './validation/ForgetPasswordRequest.dto.js';
import { ResetPasswordRequest } from './validation/ResetPasswordRequest.dto.js';
import { LogoutRequest } from './validation/LogoutRequest.dto.js';

@Controller('identity')
export class IdentityController {
  constructor(private readonly _identityService: IdentityServices) {}

  @Post('signup')
  async signUp(@Body(new ValidationPipe()) data: SignUpRequest) {
    return this._identityService.signUp(data);
  }

  @Post('login')
  async signIn(@Body(new ValidationPipe()) data: SignInRequest) {
    return this._identityService.signIn(data);
  }

  @Post('confirm')
  async confirmEmail(@Body(new ValidationPipe()) data: ConfirmEmailRequest) {
    return this._identityService.confirmEmail(data);
  }

  @Post('resend-otp')
  async resendOTP(@Body(new ValidationPipe()) data: ResendOTPRequest) {
    return this._identityService.resendOTP(data);
  }

  @Get('refresh')
  async refresh(@Body(new ValidationPipe()) data: RefreshRequest) {
    return this._identityService.refresh(data);
  }

  @Post('forget-password')
  async forgetPassword(
    @Body(new ValidationPipe()) data: ForgetPasswordRequest,
  ) {
    return this._identityService.forgetPassword(data);
  }

  @Post('reset-password')
  async resetPassword(@Body(new ValidationPipe()) data: ResetPasswordRequest) {
    return this._identityService.resetPassword(data);
  }

  @Get('logout')
  async logout(@Body(new ValidationPipe()) data: LogoutRequest) {
    return this._identityService.logout(data);
  }
}
