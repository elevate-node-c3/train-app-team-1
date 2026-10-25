import { describe, expect, it } from 'vitest';
import { commonEnvSchema } from './env.schema.js';
import { ConfigurationException, validateEnvOrThrow } from './env.validator.js';

const validCommonEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  GRPC_PORT: '50051',
  DATABASE_URL: 'postgres://identity:identity_dev@postgres:5432/identity',
  REDIS_URL: 'redis://redis:6379',
  RABBITMQ_URL: 'amqp://train_app:train_app@rabbitmq:5672',
};

describe('Shared environment validation (§2.1)', () => {
  it('passes validation when all required variables are valid', () => {
    const validated = validateEnvOrThrow(
      commonEnvSchema,
      validCommonEnv,
      'identity',
    );
    expect(validated).toBeDefined();
    expect((validated as any).PORT).toBe(3000);
  });

  it('refuses to start when a required variable is missing, and names it', () => {
    const invalidEnv = { ...validCommonEnv };
    delete (invalidEnv as any).DATABASE_URL;

    expect(() =>
      validateEnvOrThrow(commonEnvSchema, invalidEnv, 'identity'),
    ).toThrowError(ConfigurationException);

    try {
      validateEnvOrThrow(commonEnvSchema, invalidEnv, 'identity');
    } catch (err: any) {
      expect(err.message).toContain(
        "Missing required environment variable 'DATABASE_URL'",
      );
    }
  });

  it("never prints a secret's value when a secret variable is invalid", () => {
    const secretValue = 'super_secret_password_12345';
    const invalidEnv = {
      ...validCommonEnv,
      DATABASE_URL: `invalid-url-with-no-scheme-and-secret-${secretValue}`,
    };

    try {
      validateEnvOrThrow(commonEnvSchema, invalidEnv, 'identity');
      expect.unreachable('Should have thrown ConfigurationException');
    } catch (err: any) {
      expect(err.message).toContain("'DATABASE_URL'");
      expect(err.message).not.toContain(secretValue);
      expect(err.message).toContain('[REDACTED]');
    }
  });

  it('rejects a malformed port of "abc"', () => {
    try {
      validateEnvOrThrow(
        commonEnvSchema,
        { ...validCommonEnv, PORT: 'abc' },
        'identity',
      );
      expect.unreachable('Should have thrown ConfigurationException');
    } catch (err: any) {
      expect(err.message).toContain("'PORT'");
      expect(err.message).toContain('valid integer port');
    }
  });

  it('rejects a URL with no scheme', () => {
    try {
      validateEnvOrThrow(
        commonEnvSchema,
        { ...validCommonEnv, DATABASE_URL: 'localhost:5432/mydb' },
        'identity',
      );
      expect.unreachable('Should have thrown ConfigurationException');
    } catch (err: any) {
      expect(err.message).toContain("'DATABASE_URL'");
      expect(err.message).toContain('scheme postgres:// or postgresql://');
    }
  });

  it('carries no service-specific keys', () => {
    // A library shared by seven services does not know one service's SMTP host
    // or another's outbox knobs; those schemas live with their service.
    const described = commonEnvSchema.describe() as any;
    for (const key of [
      'SMTP_HOST',
      'OUTBOX_BATCH_SIZE',
      'EVENT_PREFETCH',
      'IDENTITY_GRPC_URL',
    ]) {
      expect(described.keys[key]).toBeUndefined();
    }
  });
});
