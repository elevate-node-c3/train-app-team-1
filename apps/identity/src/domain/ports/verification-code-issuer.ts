/**
 * AUTH-2's account-verification code issuance, as seen by sign-in. Issuing a
 * code is subject to the resend limits shared with password-reset codes.
 */

/** DI token for the VerificationCodeIssuer implementation. */
export const VERIFICATION_CODE_ISSUER = Symbol('VERIFICATION_CODE_ISSUER');

export type VerificationCodeIssueResult =
  { issued: true } | { issued: false; retryAfterSeconds: number };

export interface VerificationCodeIssuer {
  /**
   * Sends the account a verification code if the resend limits allow it.
   * @returns `issued: true`, or `issued: false` with the seconds until one can be sent
   */
  issue(accountId: string): Promise<VerificationCodeIssueResult>;
}
