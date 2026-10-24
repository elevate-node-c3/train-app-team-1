/**
 * Contract between identity (caller) and session management (Member 2, owner)
 * for revoking every session and device credential of an account, e.g. after
 * a password reset.
 */

/** DI token for the AccountRevocationService implementation. */
export const ACCOUNT_REVOCATION_SERVICE = Symbol('ACCOUNT_REVOCATION_SERVICE');

/**
 * Thrown when revocation could not be completed. The caller's own change
 * (e.g. the new password) stays committed; the password.reset event remains
 * the backstop for invalidating outstanding access tokens.
 */
export class AccountRevocationError extends Error {
  constructor(readonly accountId: string) {
    super('Account-wide revocation failed');
    this.name = 'AccountRevocationError';
  }
}

export interface AccountRevocationService {
  /**
   * Revokes every session and device credential of the account. Idempotent.
   * @returns resolves once everything is revoked
   */
  revokeAll(accountId: string): Promise<void>;
}
