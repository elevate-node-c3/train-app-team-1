import { describe, expect, it } from 'vitest';
import { validateEnvOrThrow } from '@app/common/config/env.validator.js';
import { paymentEnvSchema } from './env.schema.js';

describe('paymentEnvSchema', () => {
  const validBase = {
    NODE_ENV: 'development',
    PORT: '3000',
    GRPC_PORT: '50051',
    DATABASE_URL: 'postgres://payment:payment_dev@postgres:5432/payment',
    REDIS_URL: 'redis://redis:6379',
    RABBITMQ_URL: 'amqp://train_app:train_app@rabbitmq:5672',
    STRIPE_SECRET_KEY: 'sk_test_placeholderSecretKeyForTesting12345',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholderWebhookSecret12345',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholderPublishableKey12345',
  };

  it('accepts valid configuration', () => {
    expect(() =>
      validateEnvOrThrow(paymentEnvSchema, validBase, 'payment'),
    ).not.toThrow();
  });

  it('refuses boot when STRIPE_SECRET_KEY is missing and names the variable', () => {
    const { STRIPE_SECRET_KEY: _unused, ...invalid } = validBase;
    expect(() =>
      validateEnvOrThrow(paymentEnvSchema, invalid, 'payment'),
    ).toThrowError(/STRIPE_SECRET_KEY/);
  });

  it('refuses boot when STRIPE_SECRET_KEY is malformed and names the variable', () => {
    const invalid = { ...validBase, STRIPE_SECRET_KEY: 'invalid_secret_key' };
    expect(() =>
      validateEnvOrThrow(paymentEnvSchema, invalid, 'payment'),
    ).toThrowError(/STRIPE_SECRET_KEY/);
  });

  it('refuses boot when no Stripe publishable key is configured', () => {
    const { STRIPE_PUBLISHABLE_KEY: _unused, ...invalid } = validBase;
    expect(() =>
      validateEnvOrThrow(paymentEnvSchema, invalid, 'payment'),
    ).toThrowError(/STRIPE_PUBLISHABLE_KEY/);
  });

  it('refuses boot when STRIPE_WEBHOOK_SECRET is missing and names the variable', () => {
    const { STRIPE_WEBHOOK_SECRET: _unused, ...invalid } = validBase;
    expect(() =>
      validateEnvOrThrow(paymentEnvSchema, invalid, 'payment'),
    ).toThrowError(/STRIPE_WEBHOOK_SECRET/);
  });
});
