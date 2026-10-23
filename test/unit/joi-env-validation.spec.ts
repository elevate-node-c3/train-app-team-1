import { describe, expect, it } from 'vitest';
import {
  commonEnvSchema,
  notificationEnvSchema,
  validateEnvOrThrow,
  ConfigurationException,
} from '@app/common';

describe('Joi Environment Schema Validation (§2.1)', () => {
  const validCommonEnv = {
    NODE_ENV: 'development',
    PORT: '3000',
    GRPC_PORT: '50051',
    DATABASE_URL: 'postgres://identity:identity_dev@postgres:5432/identity',
    REDIS_URL: 'redis://redis:6379',
    RABBITMQ_URL: 'amqp://train_app:train_app@rabbitmq:5672',
  };

  it('passes validation when all required variables are valid', () => {
    const validated = validateEnvOrThrow(
      commonEnvSchema,
      validCommonEnv,
      'identity',
    );
    expect(validated).toBeDefined();
    expect((validated as any).PORT).toBe(3000);
  });

  it('refuses to start when a required variable is missing, and names the variable', () => {
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
    const invalidEnv = { ...validCommonEnv, PORT: 'abc' };

    try {
      validateEnvOrThrow(commonEnvSchema, invalidEnv, 'identity');
      expect.unreachable('Should have thrown ConfigurationException');
    } catch (err: any) {
      expect(err.message).toContain("'PORT'");
      expect(err.message).toContain('valid integer port');
    }
  });

  it('rejects a URL with no scheme', () => {
    const invalidEnv = {
      ...validCommonEnv,
      DATABASE_URL: 'localhost:5432/mydb',
    };

    try {
      validateEnvOrThrow(commonEnvSchema, invalidEnv, 'identity');
      expect.unreachable('Should have thrown ConfigurationException');
    } catch (err: any) {
      expect(err.message).toContain("'DATABASE_URL'");
      expect(err.message).toContain('scheme postgres:// or postgresql://');
    }
  });

  it('validates notification specific environment schema', () => {
    const validNotificationEnv = {
      ...validCommonEnv,
      SMTP_HOST: 'mailpit',
      SMTP_PORT: '1025',
    };

    const validated = validateEnvOrThrow(
      notificationEnvSchema,
      validNotificationEnv,
      'notification',
    );
    expect((validated as any).SMTP_PORT).toBe(1025);

    const missingSmtp = { ...validCommonEnv };
    expect(() =>
      validateEnvOrThrow(notificationEnvSchema, missingSmtp, 'notification'),
    ).toThrowError(/Missing required environment variable 'SMTP_HOST'/);
  });
});
