export const TOKEN_SETTINGS = Symbol('TOKEN_SETTINGS');

/**
 * The token lifetimes the auth feature needs. Binding these once from the
 * validated environment keeps environment access at the composition root.
 */
export interface TokenSettings {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  refreshGraceSeconds: number;
  verificationCodeTtlSeconds: number;
}
