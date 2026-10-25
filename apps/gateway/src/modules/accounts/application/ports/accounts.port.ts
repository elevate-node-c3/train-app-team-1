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
  VerifyEmailRequestDto,
  VerifyEmailResponseDto,
} from '@app/contracts';

export const ACCOUNTS_CLIENT = Symbol('ACCOUNTS_CLIENT');

/**
 * The gateway's view of identity. The use-case depends on this interface, not
 * on `@grpc/grpc-js`, so the transport can be replaced in a test with an object
 * literal and no channel.
 */
export interface AccountsClientPort {
  signUp(input: SignUpRequestDto): Promise<SignUpResponseDto>;
  verifyEmail(input: VerifyEmailRequestDto): Promise<VerifyEmailResponseDto>;
  resendVerification(
    input: ResendVerificationRequestDto,
  ): Promise<ResendVerificationResponseDto>;
  signIn(input: SignInRequestDto): Promise<SignInResponseDto>;
  refreshToken(input: RefreshTokenRequestDto): Promise<RefreshResponseDto>;
  signOut(input: SignOutRequestDto): Promise<SignOutResponseDto>;
  forgotPassword(
    input: ForgotPasswordRequestDto,
  ): Promise<ForgotPasswordResponseDto>;
  resetPassword(
    input: ResetPasswordRequestDto,
  ): Promise<ResetPasswordResponseDto>;
}

/** Kept for controller type symmetry; the HTTP shape is flat. */
export type VerifyEmailResult = VerifyEmailResponseDto;
