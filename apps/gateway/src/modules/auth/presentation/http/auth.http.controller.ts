import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import type {
  ForgotPasswordResponseDto,
  RefreshResponseDto,
  ResendVerificationResponseDto,
  ResetPasswordResponseDto,
  SignInResponseDto,
  SignOutResponseDto,
  SignUpResponseDto,
  TokenPairDto,
  VerifyEmailResponseDto,
} from '@app/contracts';
import {
  CurrentCaller,
  Public,
  RateLimit,
  RequireAccess,
  type AuthenticatedCaller,
} from '@app/common';
import {
  ACCOUNTS_CLIENT,
  type AccountsClientPort,
} from '../../../accounts/application/ports/accounts.port.js';
import {
  ForgotPasswordDto,
  RefreshTokenDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SignInDto,
  SignOutDto,
  SignUpDto,
  VerifyEmailDto,
} from './dto/auth.dto.js';

/**
 * The public authentication surface. Only sign-out requires a token; every
 * other route is explicitly `@Public()` because the gateway guard denies by
 * default.
 */
@Controller('auth')
export class AuthHttpController {
  constructor(
    @Inject(ACCOUNTS_CLIENT) private readonly accounts: AccountsClientPort,
  ) {}

  @Public()
  @RateLimit({ bucket: 'sign-up', limit: 10, windowSeconds: 60 })
  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  signUp(@Body() body: SignUpDto): Promise<SignUpResponseDto> {
    return this.accounts.signUp(body);
  }

  @Public()
  @RateLimit({ bucket: 'verify-email', limit: 10, windowSeconds: 60 })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(
    @Body() body: VerifyEmailDto,
  ): Promise<VerifyEmailResponseDto> {
    return this.accounts.verifyEmail(body);
  }

  @Public()
  @RateLimit({ bucket: 'resend-verification', limit: 3, windowSeconds: 300 })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  resendVerification(
    @Body() body: ResendVerificationDto,
  ): Promise<ResendVerificationResponseDto> {
    return this.accounts.resendVerification(body);
  }

  @Public()
  @RateLimit({ bucket: 'sign-in', limit: 10, windowSeconds: 60 })
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() body: SignInDto): Promise<SignInResponseDto> {
    return this.accounts.signIn(body);
  }

  @Public()
  @RateLimit({ bucket: 'refresh-token', limit: 60, windowSeconds: 60 })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: RefreshTokenDto): Promise<TokenPairDto> {
    const result: RefreshResponseDto = await this.accounts.refreshToken(body);
    return result;
  }

  @RequireAccess('traveller')
  @RateLimit({ bucket: 'sign-out', limit: 30, windowSeconds: 60 })
  @Post('sign-out')
  @HttpCode(HttpStatus.OK)
  signOut(
    @Body() body: SignOutDto,
    @CurrentCaller() caller: AuthenticatedCaller,
  ): Promise<SignOutResponseDto> {
    return this.accounts.signOut({
      refreshToken: body.refreshToken,
      sessionId: caller.sessionId,
      jti: caller.jti,
      accessTokenExpiresAt: new Date(caller.expiresAt * 1000).toISOString(),
    });
  }

  @Public()
  @RateLimit({ bucket: 'forgot-password', limit: 5, windowSeconds: 300 })
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  forgotPassword(
    @Body() body: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.accounts.forgotPassword(body);
  }

  @Public()
  @RateLimit({ bucket: 'reset-password', limit: 10, windowSeconds: 60 })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @Body() body: ResetPasswordDto,
  ): Promise<ResetPasswordResponseDto> {
    return this.accounts.resetPassword(body);
  }
}
