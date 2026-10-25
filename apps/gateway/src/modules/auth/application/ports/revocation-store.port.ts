import type {
  AccessTokenClaims,
  SessionRevokedPayloadV1,
} from '@app/contracts';

export const REVOCATION_STORE = Symbol('REVOCATION_STORE');

/**
 * The minimum a guard needs from the token to answer "was this revoked?".
 * `iat` is compared against the account-wide marker written by a password
 * reset: every token minted at or before that instant is dead.
 */
export type RevocationSubject = Pick<
  AccessTokenClaims,
  'jti' | 'sid' | 'sub' | 'iat'
>;

export interface RevocationStorePort {
  isRevoked(subject: RevocationSubject): Promise<boolean>;
  revoke(payload: SessionRevokedPayloadV1): Promise<void>;
}
