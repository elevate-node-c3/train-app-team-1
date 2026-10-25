import { describe, expect, it } from 'vitest';
import { validateEnvOrThrow } from '@app/common/config/env.validator.js';
import { NOTIFICATION_DEFAULTS } from '@app/common/config/env.defaults.js';
import { notificationEnvSchema } from './env.schema.js';

const validCommonEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  GRPC_PORT: '50051',
  DATABASE_URL:
    'postgres://notification:notification_dev@postgres:5432/notification',
  REDIS_URL: 'redis://redis:6379',
  RABBITMQ_URL: 'amqp://train_app:train_app@rabbitmq:5672',
};

function defaultOf(key: string): unknown {
  const described = notificationEnvSchema.describe() as any;
  return described.keys[key]?.flags?.default;
}

describe('Notification environment schema', () => {
  it('coerces SMTP settings and requires the host', () => {
    const validated = validateEnvOrThrow(
      notificationEnvSchema,
      { ...validCommonEnv, SMTP_HOST: 'mailpit', SMTP_PORT: '1025' },
      'notification',
    );
    expect((validated as any).SMTP_PORT).toBe(1025);

    expect(() =>
      validateEnvOrThrow(notificationEnvSchema, validCommonEnv, 'notification'),
    ).toThrowError(/Missing required environment variable 'SMTP_HOST'/);
  });

  it('keeps every code-side default equal to its Joi default', () => {
    expect(defaultOf('SMTP_FROM')).toBe(NOTIFICATION_DEFAULTS.smtpFrom);
    expect(defaultOf('EVENT_HANDLER_TIMEOUT_MS')).toBe(
      NOTIFICATION_DEFAULTS.handlerTimeoutMs,
    );
    expect(defaultOf('EVENT_RETRY_DELAYS_MS')).toBe(
      NOTIFICATION_DEFAULTS.retryDelays,
    );
    expect(defaultOf('EVENT_PREFETCH')).toBe(NOTIFICATION_DEFAULTS.prefetch);
    expect(defaultOf('EVENT_CLAIM_LEASE_SECONDS')).toBe(
      NOTIFICATION_DEFAULTS.claimLeaseSeconds,
    );
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
    ).toThrowError(/budget exceeded/);
  });
});
