export const REFRESH_TOKEN_HASHER = Symbol('REFRESH_TOKEN_HASHER');

export interface RefreshTokenHasherPort {
  generate(): string;
  hash(token: string): string;
  /** Encrypts the short-lived grace copy of a successor pair at rest. */
  seal(payload: unknown): string;
  open<T>(sealed: string): T;
}
