import { describe, expect, it } from 'vitest';
import { validateEnvOrThrow } from '@app/common/config/env.validator.js';
import {
  OUTBOX_DEFAULTS,
  VERIFICATION_CODE_DEFAULTS,
} from '@app/common/config/env.defaults.js';
import { identityEnvSchema } from './env.schema.js';
import { randomBytes } from 'node:crypto';

const nationalIdEncryptionKey = randomBytes(32).toString('base64');

const validIdentityEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  GRPC_PORT: '50051',
  DATABASE_URL: 'postgres://identity:identity_dev@postgres:5432/identity',
  REDIS_URL: 'redis://redis:6379',
  RABBITMQ_URL: 'amqp://train_app:train_app@rabbitmq:5672',
  OUTBOX_RELAY_ENABLED: 'true',
  OUTBOX_POLL_INTERVAL_MS: '500',
  OUTBOX_BATCH_SIZE: '20',
  VERIFICATION_CODE_TTL_SECONDS: '600',
  JWT_PRIVATE_KEY_FILE: 'config/jwt/dev-private.pem',
  NATIONAL_ID_ACTIVE_KEY_VERSION: '1',
  NATIONAL_ID_ENCRYPTION_KEYS: JSON.stringify({ 1: nationalIdEncryptionKey }),
  NATIONAL_ID_BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
};

function defaultOf(key: string): unknown {
  const described = identityEnvSchema.describe() as any;
  return described.keys[key]?.flags?.default;
}

describe('Identity environment schema', () => {
  it('keeps the private notification credential optional but rejects weak configured keys', () => {
    expect(() =>
      validateEnvOrThrow(identityEnvSchema, {
        ...validIdentityEnv,
        NOTIFICATION_IDENTITY_SERVICE_KEY: '',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnvOrThrow(identityEnvSchema, {
        ...validIdentityEnv,
        NOTIFICATION_IDENTITY_SERVICE_KEY: 'short',
      }),
    ).toThrow(/NOTIFICATION_IDENTITY_SERVICE_KEY/);
    expect(() =>
      validateEnvOrThrow(identityEnvSchema, {
        ...validIdentityEnv,
        NOTIFICATION_IDENTITY_SERVICE_KEY: 'a'.repeat(32),
      }),
    ).not.toThrow();
  });

  it('caps the verification code TTL at ten minutes', () => {
    expect(() =>
      validateEnvOrThrow(
        identityEnvSchema,
        { ...validIdentityEnv, VERIFICATION_CODE_TTL_SECONDS: '601' },
        'identity',
      ),
    ).toThrowError(/VERIFICATION_CODE_TTL_SECONDS/);
  });

  it('keeps every code-side default equal to its Joi default', () => {
    // validateEnv discards coerced values, so runtime defaults must match Joi.
    expect(defaultOf('OUTBOX_RELAY_ENABLED')).toBe(OUTBOX_DEFAULTS.enabled);
    expect(defaultOf('OUTBOX_POLL_INTERVAL_MS')).toBe(
      OUTBOX_DEFAULTS.pollIntervalMs,
    );
    expect(defaultOf('OUTBOX_BATCH_SIZE')).toBe(OUTBOX_DEFAULTS.batchSize);
    expect(defaultOf('VERIFICATION_CODE_TTL_SECONDS')).toBe(
      VERIFICATION_CODE_DEFAULTS.ttlSeconds,
    );
  });

  it('bounds the relay interval by its share of the delivery budget', () => {
    // Only identity has the relay setting in its environment.
    expect(() =>
      validateEnvOrThrow(
        identityEnvSchema,
        { ...validIdentityEnv, OUTBOX_POLL_INTERVAL_MS: '20000' },
        'identity',
      ),
    ).toThrowError(/delivery budget/);

    expect(() =>
      validateEnvOrThrow(identityEnvSchema, validIdentityEnv, 'identity'),
    ).not.toThrow();
  });

  it('keeps SMTP configuration out of the identity service', () => {
    const described = identityEnvSchema.describe() as any;
    expect(described.keys.SMTP_HOST).toBeUndefined();
    expect(described.keys.SMTP_PORT).toBeUndefined();
    expect(described.keys.SMTP_FROM).toBeUndefined();
  });

  it('refuses to boot without a JWT private key source', () => {
    const { JWT_PRIVATE_KEY_FILE: _file, ...withoutKey } = validIdentityEnv;

    expect(() =>
      validateEnvOrThrow(identityEnvSchema, withoutKey, 'identity'),
    ).toThrowError(/JWT_PRIVATE_KEY/);
  });

  it('leaves hold token issuance disabled with missing or blank optional settings', () => {
    expect(() =>
      validateEnvOrThrow(identityEnvSchema, {
        ...validIdentityEnv,
        BOOKING_IDENTITY_SERVICE_KEY: '',
        HOLD_PASSENGER_TOKEN_KEYS: '',
        HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '',
      }),
    ).not.toThrow();
  });

  it('requires complete purpose-specific National-ID storage keys', () => {
    const { NATIONAL_ID_BLIND_INDEX_KEY: _blind, ...withoutBlind } =
      validIdentityEnv;
    expect(() =>
      validateEnvOrThrow(identityEnvSchema, withoutBlind, 'identity'),
    ).toThrow(/NATIONAL_ID_BLIND_INDEX_KEY/);
    expect(() =>
      validateEnvOrThrow(
        identityEnvSchema,
        {
          ...validIdentityEnv,
          NATIONAL_ID_ENCRYPTION_KEYS: JSON.stringify({
            2: nationalIdEncryptionKey,
          }),
        },
        'identity',
      ),
    ).toThrow(/NATIONAL_ID_ENCRYPTION_KEYS/);
  });

  it('accepts a provisioned active key and Booking credential', () => {
    expect(() =>
      validateEnvOrThrow(identityEnvSchema, {
        ...validIdentityEnv,
        BOOKING_IDENTITY_SERVICE_KEY: 'booking-identity-test-only-credential',
        HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({
          1: Buffer.alloc(32, 0x61).toString('base64'),
          2: Buffer.alloc(32, 0x62).toString('base64'),
        }),
        HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '2',
      }),
    ).not.toThrow();
  });

  it.each([
    { BOOKING_IDENTITY_SERVICE_KEY: 'private-short-key' },
    { HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1' },
    { HOLD_PASSENGER_TOKEN_KEYS: '{private-invalid-json' },
    {
      HOLD_PASSENGER_TOKEN_KEYS: '{"1":"private-short-key"}',
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '1',
    },
    {
      HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({
        1: Buffer.alloc(32).toString('base64'),
      }),
      HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: '2',
    },
  ])(
    'rejects invalid hold configuration with secret redaction (%#)',
    (settings) => {
      expect(() =>
        validateEnvOrThrow(identityEnvSchema, {
          ...validIdentityEnv,
          ...settings,
        }),
      ).toThrowError(/Configuration error/);
      try {
        validateEnvOrThrow(identityEnvSchema, {
          ...validIdentityEnv,
          ...settings,
        });
      } catch (error) {
        expect(String(error)).not.toContain('private-short-key');
        expect(String(error)).not.toContain('private-invalid-json');
        expect(String(error)).not.toContain(
          Buffer.alloc(32).toString('base64'),
        );
      }
    },
  );
});
