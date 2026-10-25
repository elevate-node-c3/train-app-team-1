import type { EventLanguage } from '../events/event-envelope.js';

/**
 * BR-01's traveller ladder. Staff authority is not a higher rank: `operator`
 * and `conductor` are orthogonal roles, so they are declared separately below.
 */
export const ACCESS_LEVELS = ['public', 'traveller', 'bookable'] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  public: 0,
  traveller: 1,
  bookable: 2,
};

/** The two staff roles. Neither implies the other, and neither implies bookable. */
export const STAFF_ROLES = ['operator', 'conductor'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const JWT_ALGORITHM = 'RS256';
export const JWT_ISSUER = 'train-app-identity';
export const JWT_AUDIENCE = 'train-app-gateway';
export const JWT_KEY_ID_HEADER = 'kid';

export const TOKEN_DEFAULTS = {
  accessTtlSeconds: 15 * 60,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  clockSkewSeconds: 30,
  refreshGraceSeconds: 10,
} as const;

/**
 * The complete access-token claim set. Deliberately no email, name, phone or
 * any other directly identifying value: the gateway needs authorization facts,
 * not a profile (F6a).
 */
export interface AccessTokenClaims {
  /** Account id. */
  sub: string;
  /** The account's access level at mint time. */
  lvl: AccessLevel;
  /** Staff roles only. A traveller has none. */
  roles: StaffRole[];
  /** Session id, so sign-out can revoke every token in the session. */
  sid: string;
  /** Token id, so a single access token can be revoked. */
  jti: string;
  /** BR-10: whether the account may book without completing its profile. */
  bkbl: boolean;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export const ACCESS_TOKEN_CLAIM_KEYS = [
  'sub',
  'lvl',
  'roles',
  'sid',
  'jti',
  'bkbl',
  'iss',
  'aud',
  'iat',
  'exp',
] as const satisfies readonly (keyof AccessTokenClaims)[];

export interface AccessTokenHeader {
  alg: typeof JWT_ALGORITHM;
  typ: 'JWT';
  kid: string;
}

export interface TokenPairDto {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  accessExpiresIn: number;
  refreshExpiresIn: number;
}

export interface MaskedAccountDto {
  accountId: string;
  maskedEmail: string;
  language: EventLanguage;
}

export interface SignUpResponseDto {
  accountId: string;
  maskedEmail: string;
  language: EventLanguage;
  /** Seconds until another code may be requested. */
  resendAfterSeconds: number;
}

export interface VerifyEmailResponseDto extends TokenPairDto {
  accountId: string;
  maskedEmail: string;
}

export interface ResendVerificationResponseDto {
  maskedEmail: string;
  secondsRemaining: number;
}

export interface SignInResponseDto {
  verificationRequired: boolean;
  maskedEmail: string;
  secondsRemaining: number;
  tokens: TokenPairDto | null;
}

export interface RefreshResponseDto extends TokenPairDto {}

export interface SignOutResponseDto {
  revoked: true;
}

export interface ForgotPasswordResponseDto {
  secondsRemaining: number;
}

export interface ResetPasswordResponseDto {
  reset: true;
}
