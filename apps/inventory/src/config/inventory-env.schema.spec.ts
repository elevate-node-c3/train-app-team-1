import { describe, expect, it } from 'vitest';
import { validateEnvOrThrow } from '@app/common';
import { inventoryEnvSchema } from './inventory-env.schema.js';

const base = {
  PORT: '3000',
  DATABASE_URL: 'postgres://localhost/test',
  REDIS_URL: 'redis://localhost',
  RABBITMQ_URL: 'amqp://localhost',
};
describe('Inventory hold runtime configuration', () => {
  it('keeps creation off but durable maintenance on by default', () => {
    expect(validateEnvOrThrow(inventoryEnvSchema, base)).toMatchObject({
      HOLD_CREATION_ENABLED: false,
      HOLD_EXPIRY_WORKER_ENABLED: true,
      OUTBOX_PUBLISH_CONCURRENCY: 32,
    });
  });
  it('requires a separate service credential to enable creation', () => {
    expect(() =>
      validateEnvOrThrow(inventoryEnvSchema, {
        ...base,
        HOLD_CREATION_ENABLED: 'true',
      }),
    ).toThrow('BOOKING_INVENTORY_SERVICE_KEY');
    expect(
      validateEnvOrThrow(inventoryEnvSchema, {
        ...base,
        HOLD_CREATION_ENABLED: 'true',
        BOOKING_INVENTORY_SERVICE_KEY: 'test-credential-longer-than-thirty-two',
      }),
    ).toMatchObject({ HOLD_CREATION_ENABLED: true });
  });
  it('normalizes accepted boolean spellings before runtime guards consume them', () => {
    expect(
      validateEnvOrThrow(inventoryEnvSchema, {
        ...base,
        HOLD_CREATION_ENABLED: 'TRUE',
        HOLD_EXPIRY_WORKER_ENABLED: 'FALSE',
        BOOKING_INVENTORY_SERVICE_KEY: 'test-credential-longer-than-thirty-two',
      }),
    ).toMatchObject({
      HOLD_CREATION_ENABLED: true,
      HOLD_EXPIRY_WORKER_ENABLED: false,
    });
  });
  it.each([
    'HOLD_EXPIRY_BATCH_SIZE',
    'HOLD_EXPIRY_POLL_INTERVAL_MS',
    'OUTBOX_BATCH_SIZE',
    'OUTBOX_POLL_INTERVAL_MS',
    'AMQP_PUBLISH_CONFIRM_TIMEOUT_MS',
  ])('refuses unbounded or invalid worker setting %s', (name) => {
    expect(() =>
      validateEnvOrThrow(inventoryEnvSchema, { ...base, [name]: '0' }),
    ).toThrow(name);
    expect(() =>
      validateEnvOrThrow(inventoryEnvSchema, { ...base, [name]: '9999999' }),
    ).toThrow(name);
  });
  it('never prints a rejected service secret', () => {
    try {
      validateEnvOrThrow(inventoryEnvSchema, {
        ...base,
        HOLD_CREATION_ENABLED: 'true',
        BOOKING_INVENTORY_SERVICE_KEY: 'sensitive-short',
      });
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-short');
    }
  });
  it('keeps parallel broker confirms bounded', () => {
    for (const value of ['0', '1.5', '65']) {
      expect(() =>
        validateEnvOrThrow(inventoryEnvSchema, {
          ...base,
          OUTBOX_PUBLISH_CONCURRENCY: value,
        }),
      ).toThrow('OUTBOX_PUBLISH_CONCURRENCY');
    }
  });
});
