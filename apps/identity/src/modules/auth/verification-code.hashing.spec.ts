import { describe, expect, it } from 'vitest';
import {
  generateVerificationCode,
  generateVerificationCodeSalt,
  hashVerificationCode,
  verifyVerificationCode,
} from './verification-code.hashing.js';

describe('verification-code hashing', () => {
  it('generates uniform six-digit codes', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateVerificationCode()).toMatch(/^\d{6}$/);
    }
  });

  it('hashes the same plaintext to different values for every row', () => {
    const firstSalt = generateVerificationCodeSalt();
    const secondSalt = generateVerificationCodeSalt();
    const firstHash = hashVerificationCode('483920', firstSalt);
    const secondHash = hashVerificationCode('483920', secondSalt);

    expect(firstSalt).not.toBe(secondSalt);
    expect(firstHash).not.toBe(secondHash);
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies only the matching plaintext', () => {
    const salt = generateVerificationCodeSalt();
    const hash = hashVerificationCode('483920', salt);

    expect(verifyVerificationCode('483920', salt, hash)).toBe(true);
    expect(verifyVerificationCode('000000', salt, hash)).toBe(false);
  });
});
