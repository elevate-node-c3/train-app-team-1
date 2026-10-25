import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import {
  ACCESS_LEVELS,
  ACCESS_TOKEN_CLAIM_KEYS,
  STAFF_ROLES,
  type AccessLevel,
  type AccessTokenClaims,
  type StaffRole,
} from '@app/contracts';

export interface SignAccessTokenInput {
  sub: string;
  lvl: AccessLevel;
  roles: StaffRole[];
  sid: string;
  bkbl: boolean;
  jti?: string;
  now?: Date;
}

export class AccessTokenVerificationError extends Error {
  constructor(
    readonly reason: 'expired' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AccessTokenVerificationError';
  }
}

/** Claims are assembled in one place so a PII field cannot slip in per-call. */
export function buildAccessTokenClaims(
  input: SignAccessTokenInput,
  options: {
    issuer: string;
    audience: string;
    accessTtlSeconds: number;
  },
): AccessTokenClaims {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return {
    sub: input.sub,
    lvl: input.lvl,
    roles: [...input.roles],
    sid: input.sid,
    jti: input.jti ?? randomUUID(),
    bkbl: input.bkbl,
    iss: options.issuer,
    aud: options.audience,
    iat,
    exp: iat + options.accessTtlSeconds,
  };
}

export function assertClaims(payload: JWTPayload): AccessTokenClaims {
  const lvl = payload.lvl;
  const roles = payload.roles;
  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof lvl !== 'string' ||
    !(ACCESS_LEVELS as readonly string[]).includes(lvl) ||
    !Array.isArray(roles) ||
    !roles.every(
      (role) =>
        typeof role === 'string' &&
        (STAFF_ROLES as readonly string[]).includes(role),
    ) ||
    typeof payload.sid !== 'string' ||
    payload.sid.length === 0 ||
    typeof payload.jti !== 'string' ||
    payload.jti.length === 0 ||
    typeof payload.bkbl !== 'boolean' ||
    typeof payload.iss !== 'string' ||
    typeof payload.aud !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new AccessTokenVerificationError('invalid', 'Invalid claims');
  }

  const claims = {} as AccessTokenClaims;
  for (const key of ACCESS_TOKEN_CLAIM_KEYS) {
    (claims as unknown as Record<string, unknown>)[key] = payload[key];
  }
  return claims;
}
