import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { resolveLanguage } from '@app/common';
import { PasswordRecoveryService } from '../domain/password-recovery.service.js';
import { SignInService } from '../domain/sign-in.service.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { SignInDto } from './dto/sign-in.dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly signInService: SignInService,
    private readonly passwordRecovery: PasswordRecoveryService,
  ) {}

  /**
   * POST /auth/sign-in
   * @returns 200 with the created session
   */
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() body: SignInDto, @Req() req: Request) {
    return this.signInService.signIn(body.email, body.password, {
      deviceId: req.header('x-device-id'),
      userAgent: req.header('user-agent'),
      ipAddress: req.ip,
    });
  }

  /**
   * POST /auth/password/forgot
   * @returns 202 with no data, the same for every email
   */
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(
    @Body() body: ForgotPasswordDto,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<null> {
    await this.passwordRecovery.requestReset(
      body.email,
      resolveLanguage(acceptLanguage),
    );
    return null;
  }

  /**
   * POST /auth/password/reset
   * @returns 200 with no data once the password is changed
   */
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: ResetPasswordDto): Promise<null> {
    await this.passwordRecovery.resetPassword(
      body.email,
      body.code,
      body.newPassword,
      body.confirmPassword,
    );
    return null;
  }
}
