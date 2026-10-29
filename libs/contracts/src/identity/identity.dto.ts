import type { EventLanguage } from '../events/event-envelope.js';

export interface SignUpRequestDto {
  email: string;
  /** Plaintext only for the duration of the call; identity hashes it at once. */
  password: string;
  /**
   * Optional on the wire because the gRPC caller may omit it; identity then
   * defaults the account to Arabic, the platform fallback (BR-56).
   */
  language?: EventLanguage;
}

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
