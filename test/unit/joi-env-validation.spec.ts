import { describe, expect, it } from 'vitest';
import {
  commonEnvSchema,
  identityEnvSchema,
  notificationEnvSchema,
  validateEnvOrThrow,
  ConfigurationException,
  NOTIFICATION_DEFAULTS,
  OUTBOX_DEFAULTS,
  VERIFICATION_CODE_DEFAULTS,
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

  describe('messaging environment (T6)', () => {
    const validIdentityEnv = {
      ...validCommonEnv,
      OUTBOX_RELAY_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: '500',
      OUTBOX_BATCH_SIZE: '20',
      VERIFICATION_CODE_TTL_SECONDS: '600',
    };

    function defaultOf(schema: typeof identityEnvSchema, key: string) {
      const described = schema.describe() as any;
      return described.keys[key]?.flags?.default;
    }

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
      // validateEnv() discards the coerced value, so code reads these
      // constants. A drifting pair is a silently wrong runtime default.
      expect(defaultOf(identityEnvSchema, 'OUTBOX_RELAY_ENABLED')).toBe(
        OUTBOX_DEFAULTS.enabled,
      );
      expect(defaultOf(identityEnvSchema, 'OUTBOX_POLL_INTERVAL_MS')).toBe(
        OUTBOX_DEFAULTS.pollIntervalMs,
      );
      expect(defaultOf(identityEnvSchema, 'OUTBOX_BATCH_SIZE')).toBe(
        OUTBOX_DEFAULTS.batchSize,
      );
      expect(defaultOf(identityEnvSchema, 'VERIFICATION_CODE_TTL_SECONDS')).toBe(
        VERIFICATION_CODE_DEFAULTS.ttlSeconds,
      );

      expect(defaultOf(notificationEnvSchema as any, 'SMTP_FROM')).toBe(
        NOTIFICATION_DEFAULTS.smtpFrom,
      );
      expect(
        defaultOf(notificationEnvSchema as any, 'EVENT_HANDLER_TIMEOUT_MS'),
      ).toBe(NOTIFICATION_DEFAULTS.handlerTimeoutMs);
      expect(
        defaultOf(notificationEnvSchema as any, 'EVENT_RETRY_DELAYS_MS'),
      ).toBe(NOTIFICATION_DEFAULTS.retryDelays);
      expect(defaultOf(notificationEnvSchema as any, 'EVENT_PREFETCH')).toBe(
        NOTIFICATION_DEFAULTS.prefetch,
      );
      expect(
        defaultOf(notificationEnvSchema as any, 'EVENT_CLAIM_LEASE_SECONDS'),
      ).toBe(NOTIFICATION_DEFAULTS.claimLeaseSeconds);
    });

    it('keeps SMTP configuration out of the identity service', () => {
      const described = identityEnvSchema.describe() as any;
      expect(described.keys.SMTP_HOST).toBeUndefined();
      expect(described.keys.SMTP_PORT).toBeUndefined();
      expect(described.keys.SMTP_FROM).toBeUndefined();
    });

    it('runs the BR-03 budget check on the configured delays', () => {
      expect(() =>
        validateEnvOrThrow(
          notificationEnvSchema,
          {
            ...validCommonEnv,
            SMTP_HOST: 'mailpit',
            SMTP_PORT: '1025',
            EVENT_RETRY_DELAYS_MS: '10000,10000,10000',
          },
          'notification',
        ),
      ).toThrowError(/BR-03/);
    });
  });
});
