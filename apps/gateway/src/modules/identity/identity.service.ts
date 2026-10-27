import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type {
  ForgotPasswordRequestDto,
  ForgotPasswordResponseDto,
  RefreshResponseDto,
  RefreshTokenRequestDto,
  ResendVerificationRequestDto,
  ResendVerificationResponseDto,
  ResetPasswordRequestDto,
  ResetPasswordResponseDto,
  SignInRequestDto,
  SignInResponseDto,
  SignOutRequestDto,
  SignOutResponseDto,
  SignUpRequestDto,
  SignUpResponseDto,
  TokenPairDto,
  VerifyEmailRequestDto,
  VerifyEmailResponseDto,
} from '@app/contracts';
import { IdentityGrpcClient } from './identity.grpc.client.js';
import type { WireTokenPair } from './identity.types.js';

/**
 * The gateway's identity surface, shaped for HTTP.
 *
 * Transport lives in `IdentityGrpcClient`; this service owns the one edge
 * decision that is not transport: identity speaks wire token pairs, the
 * gateway's public contract speaks `Bearer` pairs, and a missing pair after a
 * successful verification or refresh is a server error — never a null token.
 */
@Injectable()
export class IdentityService {
  constructor(private readonly client: IdentityGrpcClient) {}

  signUp(input: SignUpRequestDto): Promise<SignUpResponseDto> {
    return this.client.signUp(input);
  }

  async verifyEmail(
    input: VerifyEmailRequestDto,
  ): Promise<VerifyEmailResponseDto> {
    const response = await this.client.verifyEmail(input);
    if (!response.tokens) {
      throw new InternalServerErrorException('identity returned no token pair');
    }
    return {
      ...toTokenPair(response.tokens),
      accountId: response.accountId,
      maskedEmail: response.maskedEmail,
    };
  }

  resendVerification(
    input: ResendVerificationRequestDto,
  ): Promise<ResendVerificationResponseDto> {
    return this.client.resendVerification(input);
  }

  async signIn(input: SignInRequestDto): Promise<SignInResponseDto> {
    const response = await this.client.signIn(input);
    return {
      verificationRequired: response.verificationRequired,
      maskedEmail: response.maskedEmail,
      secondsRemaining: response.secondsRemaining,
      tokens: response.tokens ? toTokenPair(response.tokens) : null,
    };
  }

  async refreshToken(
    input: RefreshTokenRequestDto,
  ): Promise<RefreshResponseDto> {
    const response = await this.client.refreshToken(input);
    if (!response.tokens) {
      throw new InternalServerErrorException('identity returned no token pair');
    }
    return toTokenPair(response.tokens);
  }

  signOut(input: SignOutRequestDto): Promise<SignOutResponseDto> {
    return this.client.signOut(input);
  }

  forgotPassword(
    input: ForgotPasswordRequestDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.client.forgotPassword(input);
  }

  resetPassword(
    input: ResetPasswordRequestDto,
  ): Promise<ResetPasswordResponseDto> {
    return this.client.resetPassword(input);
  }
}

function toTokenPair(tokens: WireTokenPair): TokenPairDto {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: 'Bearer',
    accessExpiresIn: tokens.accessExpiresIn,
    refreshExpiresIn: tokens.refreshExpiresIn,
  };
}
