import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export type CodePurpose = 'password_reset' | 'email_verification';

export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Generates a random code with the crypto RNG. Never log it.
 * @returns a 6-digit code, zero-padded
 */
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Hashes a code for storage. Including the purpose stops a verification code
 * working as a reset code.
 * @returns the HMAC of `purpose|accountId|code`, as hex
 */
export function hashCode(
  purpose: CodePurpose,
  accountId: string,
  code: string,
): string {
  return hmac(`${purpose}|${accountId}|${code}`);
}

/**
 * Compares two code hashes in constant time.
 * @returns true if they are equal
 */
export function codeHashesMatch(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Hashes an email for use in Redis key names.
 * @returns the HMAC of the email, as hex
 */
export function hashEmail(email: string): string {
  return hmac(email);
}

/**
 * Keys a SHA-256 HMAC with IDENTITY_CODE_HMAC_SECRET.
 * @returns the HMAC of `value`, as hex
 */
function hmac(value: string): string {
  return createHmac('sha256', process.env.IDENTITY_CODE_HMAC_SECRET as string)
    .update(value)
    .digest('hex');
}
