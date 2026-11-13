export const TOKEN_SETTINGS = Symbol('TOKEN_SETTINGS');

/** Read validated token lifetimes once during app setup. */
export interface TokenSettings {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  refreshGraceSeconds: number;
  verificationCodeTtlSeconds: number;
}
