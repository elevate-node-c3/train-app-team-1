import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptNationalId,
  encryptNationalId,
  nationalIdBlindIndex,
  validateNationalIdVaultEnvironment,
} from './national-id-vault.js';

const nationalId = '28505150101235';
beforeEach(() => {
  vi.stubEnv('NATIONAL_ID_ACTIVE_KEY_VERSION', '1');
  vi.stubEnv(
    'NATIONAL_ID_ENCRYPTION_KEYS',
    JSON.stringify({ 1: randomBytes(32).toString('base64') }),
  );
  vi.stubEnv('NATIONAL_ID_BLIND_INDEX_KEY', randomBytes(32).toString('base64'));
});
afterEach(() => vi.unstubAllEnvs());

describe('MT-02 National-ID vault', () => {
  it('stores authenticated randomized ciphertext and decrypts only in Identity', () => {
    const first = encryptNationalId(nationalId, 'passenger');
    const second = encryptNationalId(nationalId, 'passenger');
    expect(first).not.toBe(second);
    expect(first).not.toContain(nationalId);
    expect(decryptNationalId(first, 'passenger')).toBe(nationalId);
    expect(() => decryptNationalId(first, 'account')).toThrow(
      'failed authentication',
    );
  });

  it('gives canonical Arabic/ASCII digit variants the same blind index', () => {
    const eastern = nationalId.replace(/\d/g, (digit) =>
      String.fromCharCode(0x660 + Number(digit)),
    );
    expect(nationalIdBlindIndex(eastern)).toBe(
      nationalIdBlindIndex(nationalId),
    );
    expect(nationalIdBlindIndex(nationalId)).toHaveLength(64);
  });

  it('detects tampering and never falls back to plaintext', () => {
    const encrypted = encryptNationalId(nationalId, 'passenger');
    const parts = encrypted.split(':');
    const ciphertext = Buffer.from(parts.at(-1)!, 'base64url');
    ciphertext[0] ^= 1;
    parts[parts.length - 1] = ciphertext.toString('base64url');
    expect(() => decryptNationalId(parts.join(':'), 'passenger')).toThrow(
      'failed authentication',
    );
    expect(() => decryptNationalId(nationalId, 'passenger')).toThrow(
      'not encrypted',
    );
  });

  it('fails closed for missing or invalid purpose-specific keys', () => {
    vi.stubEnv('NATIONAL_ID_ENCRYPTION_KEYS', '');
    expect(validateNationalIdVaultEnvironment).toThrow('invalid');
    vi.stubEnv(
      'NATIONAL_ID_ENCRYPTION_KEYS',
      JSON.stringify({ 1: randomBytes(31).toString('base64') }),
    );
    expect(validateNationalIdVaultEnvironment).toThrow('32 bytes');
  });
});
