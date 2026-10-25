export const TOKEN_SETTINGS = Symbol('TOKEN_SETTINGS');

/**
 * The token lifetimes an application service needs. Binding these once from
 * the validated environment keeps `process.env` out of the application and
 * domain layers.
 */
export interface TokenSettings {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  refreshGraceSeconds: number;
  verificationCodeTtlSeconds: number;
}
