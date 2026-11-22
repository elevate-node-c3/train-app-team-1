import { DataSource } from 'typeorm';

import { migrations } from '../../../apps/payment/src/database/migrations/index.js';
import { PaymentChargeEntity } from '../../../apps/payment/src/modules/charges/entities/payment-charge.entity.js';
import { StripeEventEntity } from '../../../apps/payment/src/modules/charges/entities/stripe-event.entity.js';
import { PaymentCustomerEntity } from '../../../apps/payment/src/modules/cards/entities/payment-customer.entity.js';
import { SavedCardEntity } from '../../../apps/payment/src/modules/cards/entities/saved-card.entity.js';
import { assertReachable } from './catalog-database.js';

/**
 * Use the override's host port and payment role, not the superuser, so
 * missing grants fail here as they would in the service.
 */
export const PAYMENT_DATABASE_URL =
  process.env.PAYMENT_TEST_DATABASE_URL ??
  `postgres://payment:${process.env.PAYMENT_DB_PASSWORD ?? 'payment_dev'}@127.0.0.1:${
    process.env.POSTGRES_HOST_PORT ?? '15432'
  }/payment`;

/** Every payment table, children before parents, for truncation. */
export const PAYMENT_TABLES = [
  'stripe_event',
  'payment_charge',
  'saved_card',
  'payment_customer',
  'outbox_event',
] as const;

let dataSource: DataSource | null = null;

async function assertDatabaseReachable(): Promise<void> {
  const url = new URL(PAYMENT_DATABASE_URL);
  await assertReachable('Postgres', url.hostname, Number(url.port || 5432));
}

/**
 * Reuse one connection per spec file and run migrations without booting a
 * service. TypeORM's ledger prevents applying migrations twice.
 */
export async function paymentDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;

  await assertDatabaseReachable();

  dataSource = new DataSource({
    type: 'postgres',
    url: PAYMENT_DATABASE_URL,
    synchronize: false,
    migrations,
    entities: [
      PaymentChargeEntity,
      StripeEventEntity,
      PaymentCustomerEntity,
      SavedCardEntity,
    ],
    extra: { connectionTimeoutMillis: 5000 },
  });

  await withRetries(() => dataSource!.initialize(), 'connect to Postgres');
  await withRetries(() => dataSource!.runMigrations(), 'apply migrations');

  return dataSource;
}

async function withRetries<T>(
  work: () => Promise<T>,
  description: string,
  attempts = 10,
  delayMs = 500,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error: unknown) {
      lastError = error;
      await new Promise((settle) => setTimeout(settle, delayMs));
    }
  }

  throw new Error(
    `Failed to ${description} after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function closePaymentDataSource(): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  dataSource = null;
}

/** Truncate in one statement. Caller-supplied UUIDs need no RESTART IDENTITY. */
export async function truncatePayment(source: DataSource): Promise<void> {
  await source.query(`TRUNCATE TABLE ${PAYMENT_TABLES.join(', ')} CASCADE`);
}
