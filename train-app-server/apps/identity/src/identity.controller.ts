import { Body, Controller, Get, Post } from '@nestjs/common';
import { IdentityService } from './identity.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { ResendVerificationCodeDto } from './dto/resend-verification-code.dto.js';

@Controller('identity/v1/auth')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Get()
  getHello(): string {
    return this.identityService.getHello();
  }

  @Post('signup')
  async signup(@Body() dto: SignupDto) {
    return this.identityService.signup(dto);
  }

  @Post('verify-email')
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.identityService.verifyEmail(dto);
  }

  @Post('resend-verification-code')
  async resendVerificationCode(@Body() dto: ResendVerificationCodeDto) {
    return this.identityService.resendVerificationCode(dto);
  }
}
