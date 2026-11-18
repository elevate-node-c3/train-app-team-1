import { describe, expect, it } from 'vitest';
import { holdPassengerTokenSettingsFromEnv } from './hold-passenger-token-settings.js';

const key = Buffer.alloc(32, 0x71).toString('base64');

describe('hold passenger token settings', () => {
  it('disables issuance without purpose-specific keys, including empty Compose values', () => {
    for (const env of [
      {},
      {
        HOLD_PASSENGER_TOKEN_KEYS: '',
        HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '',
      },
      {
        JWT_PRIVATE_KEY: key,
        TOKEN_GRACE_SECRET: key,
        BOOKING_IDENTITY_SERVICE_KEY: key,
      },
    ]) {
      const settings = holdPassengerTokenSettingsFromEnv(env);
      expect(settings.activeVersion).toBeNull();
      expect(settings.keys.size).toBe(0);
    }
  });

  it('decodes the complete versioned key ring and selects the active version', () => {
    const oldKey = Buffer.alloc(48, 0x72);
    const settings = holdPassengerTokenSettingsFromEnv({
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({
        1: oldKey.toString('base64'),
        2: key,
      }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '2',
    });
    expect(settings.activeVersion).toBe(2);
    expect(settings.keys.get(1)).toEqual(oldKey);
    expect(settings.keys.get(2)).toEqual(Buffer.from(key, 'base64'));
  });

  it.each([
    { HOLD_PASSENGER_TOKEN_KEYS: key },
    { HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1' },
    { HOLD_PASSENGER_TOKEN_KEYS: '', HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1' },
    {
      HOLD_PASSENGER_TOKEN_KEYS: '{broken private key material',
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: 'null',
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: '[]',
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: '{}',
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '2',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '0',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '-1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1.5',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '01',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1e0',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '2147483648',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 0: key, 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ '01': key, 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 2147483648: key, 1: key }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: 123 }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({
        1: Buffer.alloc(31).toString('base64'),
      }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: `${key}\n` }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({ 1: `!${key}` }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
  ])('rejects invalid settings without including their values (%#)', (env) => {
    expect(() => holdPassengerTokenSettingsFromEnv(env)).toThrow(
      'Invalid HOLD_PASSENGER_TOKEN_KEYS / HOLD_PASSENGER_TOKEN_ACTIVE_VERSION configuration',
    );
    try {
      holdPassengerTokenSettingsFromEnv(env);
    } catch (error) {
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain('broken private key material');
    }
  });
});
