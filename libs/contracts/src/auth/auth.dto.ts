export interface VerifyEmailRequestDto {
  email: string;
  code: string;
  deviceId?: string;
}

export interface ResendVerificationRequestDto {
  email: string;
}

export interface SignInRequestDto {
  email: string;
  password: string;
  deviceId?: string;
}

export interface RefreshTokenRequestDto {
  refreshToken: string;
}

export interface SignOutRequestDto {
  refreshToken: string;
  /** Verified by the gateway; identity never trusts a client-supplied value. */
  sessionId: string;
  jti: string;
  /** ISO-8601. Keeps a revocation marker alive only as long as it matters. */
  accessTokenExpiresAt: string;
}

export interface ForgotPasswordRequestDto {
  email: string;
}

export interface ResetPasswordRequestDto {
  email: string;
  code: string;
  newPassword: string;
}
