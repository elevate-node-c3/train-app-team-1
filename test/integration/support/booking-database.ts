import { DataSource } from 'typeorm';

import { migrations } from '../../../apps/booking/src/database/migrations/index.js';
import { BookingDraftEntity } from '../../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../../../apps/booking/src/modules/flow/entities/ticket.entity.js';
import { assertReachable } from './catalog-database.js';

/**
 * Use the override's host port and booking role, not the superuser, so
 * missing grants fail here as they would in the service.
 */
export const BOOKING_DATABASE_URL =
  process.env.BOOKING_TEST_DATABASE_URL ??
  `postgres://booking:${process.env.BOOKING_DB_PASSWORD ?? 'booking_dev'}@127.0.0.1:${
    process.env.POSTGRES_HOST_PORT ?? '15432'
  }/booking`;

/** Every booking table, children before parents, for truncation. */
export const BOOKING_TABLES = [
  'ticket',
  'booking_compensation_dead_letter',
  'booking_draft',
  'processed_event',
  'outbox_event',
] as const;

let dataSource: DataSource | null = null;

async function assertDatabaseReachable(): Promise<void> {
  const url = new URL(BOOKING_DATABASE_URL);
  await assertReachable('Postgres', url.hostname, Number(url.port || 5432));
}

/**
 * Reuse one connection per spec file and run migrations without booting a
 * service. TypeORM's ledger prevents applying migrations twice.
 */
export async function bookingDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;

  await assertDatabaseReachable();

  dataSource = new DataSource({
    type: 'postgres',
    url: BOOKING_DATABASE_URL,
    synchronize: false,
    migrations,
    entities: [BookingDraftEntity, TicketEntity],
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

export async function closeBookingDataSource(): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  dataSource = null;
}

/** Truncate in one statement. Caller-supplied UUIDs need no RESTART IDENTITY. */
export async function truncateBooking(source: DataSource): Promise<void> {
  await source.query(`TRUNCATE TABLE ${BOOKING_TABLES.join(', ')} CASCADE`);
}
