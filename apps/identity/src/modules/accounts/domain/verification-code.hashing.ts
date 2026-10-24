import {
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function generateVerificationCodeSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex');
}

/**
 * scrypt with a per-row salt. The salt is not a secret; it is what makes two
 * users who happen to receive the same six digits store different hashes.
 */
export function hashVerificationCode(code: string, salt: string): string {
  return scryptSync(code, salt, KEY_BYTES).toString('hex');
}

export function verifyVerificationCode(
  code: string,
  salt: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashVerificationCode(code, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

/** Six digits, uniform. Never derived from the account or the clock. */
export function generateVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
