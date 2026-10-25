export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/**
 * Hashing is a crossing (CPU, a library, a cost factor), so the application
 * layer sees a port. The 72-byte bcrypt limit is enforced by the adapter.
 */
export interface PasswordHasherPort {
  hash(plaintext: string): Promise<string>;
  verify(plaintext: string, hash: string): Promise<boolean>;
}
