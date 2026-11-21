import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { migrations } from '../../apps/payment/src/database/migrations/index.js';
import { PaymentChargeEntity } from '../../apps/payment/src/modules/charges/entities/payment-charge.entity.js';
import { StripeEventEntity } from '../../apps/payment/src/modules/charges/entities/stripe-event.entity.js';

const source = new DataSource({
  type: 'postgres',
  url:
    process.env.PAYMENT_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://test:test@127.0.0.1:5432/test',
  synchronize: false,
  migrations,
  entities: [PaymentChargeEntity, StripeEventEntity],
  extra: { connectionTimeoutMillis: 5000 },
});

describe('payment schema', () => {
  beforeAll(async () => {
    await source.initialize();
    await source.runMigrations();
  });

  afterAll(async () => {
    await source.destroy();
  });

  it('has an outbox_event table with the unpublished partial index', async () => {
    const columns: { column_name: string }[] = await source.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'outbox_event'`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'event_type',
        'event_version',
        'routing_key',
        'payload',
        'correlation_id',
        'producer',
        'occurred_at',
        'published_at',
        'attempt_count',
        'next_attempt_at',
        'last_error',
      ]),
    );
    const indexes: { indexname: string }[] = await source.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'outbox_event'`,
    );
    expect(indexes.map((i) => i.indexname)).toContain(
      'idx_outbox_event_unpublished',
    );
  });

  it('refuses a second stripe_event row for the same object and type', async () => {
    await source.query(
      `INSERT INTO stripe_event (id, type, object_id, payload)
       VALUES ('evt_1', 'payment_intent.succeeded', 'pi_1', '{}'::jsonb)`,
    );
    await expect(
      source.query(
        `INSERT INTO stripe_event (id, type, object_id, payload)
         VALUES ('evt_2', 'payment_intent.succeeded', 'pi_1', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/unique/i);
  });
});
