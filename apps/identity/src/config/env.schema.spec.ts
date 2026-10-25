import { describe, expect, it } from 'vitest';
import { validateEnvOrThrow } from '@app/common/config/env.validator.js';
import {
  OUTBOX_DEFAULTS,
  VERIFICATION_CODE_DEFAULTS,
} from '@app/common/config/env.defaults.js';
import { identityEnvSchema } from './env.schema.js';

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
};

function defaultOf(key: string): unknown {
  const described = identityEnvSchema.describe() as any;
  return described.keys[key]?.flags?.default;
}

describe('Identity environment schema', () => {
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
    // validateEnv() discards the coerced value, so code reads these constants.
    // A drifting pair is a silently wrong runtime default.
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
    // Identity owns this knob, so identity is the only process that can catch
    // it being mis-set. Notification used to read OUTBOX_POLL_INTERVAL_MS off
    // its own environment, where Compose never sets it, so nothing checked it.
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
});
