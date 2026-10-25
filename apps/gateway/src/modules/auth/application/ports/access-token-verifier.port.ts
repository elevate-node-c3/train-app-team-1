import type { AccessTokenClaims } from '@app/contracts';

export const ACCESS_TOKEN_VERIFIER = Symbol('ACCESS_TOKEN_VERIFIER');

/**
 * What the guard needs from token verification, and nothing more.
 *
 * The guard is presentation and the implementation is infrastructure, so it
 * depends on this rather than on the `jose`-backed class directly.
 */
export interface AccessTokenVerifierPort {
  verify(token: string): Promise<AccessTokenClaims>;
}
