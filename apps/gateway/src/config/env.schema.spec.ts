import { describe, expect, it } from 'vitest';
import { validateEnvOrThrow } from '@app/common/config/env.validator.js';
import { gatewayEnvSchema } from './env.schema.js';

const validGatewayEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  GRPC_PORT: '50051',
  DATABASE_URL: 'postgres://gateway:gateway_dev@postgres:5432/gateway',
  REDIS_URL: 'redis://redis:6379',
  RABBITMQ_URL: 'amqp://train_app:train_app@rabbitmq:5672',
  JWT_PUBLIC_KEY_FILE: 'config/jwt/dev-public.pem',
};

describe('Gateway environment schema', () => {
  it('accepts a public key by file', () => {
    expect(() =>
      validateEnvOrThrow(gatewayEnvSchema, validGatewayEnv, 'gateway'),
    ).not.toThrow();
  });

  it('accepts a public key inline', () => {
    const { JWT_PUBLIC_KEY_FILE: _file, ...rest } = validGatewayEnv;

    expect(() =>
      validateEnvOrThrow(
        gatewayEnvSchema,
        { ...rest, JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----' },
        'gateway',
      ),
    ).not.toThrow();
  });

  it('refuses to boot without a public key source', () => {
    // Enforced here rather than in the DI provider that reads the key: the
    // skeleton test compiles every root module with no environment, so a
    // provider that throws while Nest is wiring takes the whole app down.
    const { JWT_PUBLIC_KEY_FILE: _file, ...withoutKey } = validGatewayEnv;

    expect(() =>
      validateEnvOrThrow(gatewayEnvSchema, withoutKey, 'gateway'),
    ).toThrowError(/JWT_PUBLIC_KEY/);
  });

  it('never asks the gateway for a private key', () => {
    const described = gatewayEnvSchema.describe() as any;
    expect(described.keys.JWT_PRIVATE_KEY).toBeUndefined();
    expect(described.keys.JWT_PRIVATE_KEY_FILE).toBeUndefined();
  });
});
