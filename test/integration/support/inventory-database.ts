import { DataSource } from 'typeorm';

import { migrations } from '../../../apps/inventory/src/database/migrations/index.js';
import { InventoryTripEntity } from '../../../apps/inventory/src/modules/seats/entities/inventory-trip.entity.js';
import { TripStopEntity } from '../../../apps/inventory/src/modules/seats/entities/trip-stop.entity.js';
import { TripCoachEntity } from '../../../apps/inventory/src/modules/seats/entities/trip-coach.entity.js';
import { TripSeatEntity } from '../../../apps/inventory/src/modules/seats/entities/trip-seat.entity.js';
import { SeatOccupationEntity } from '../../../apps/inventory/src/modules/seats/entities/seat-occupation.entity.js';
import { assertReachable, countStatements } from './catalog-database.js';

export { countStatements };

/**
 * Use the override's host port and inventory role, not the superuser,
 * so missing grants fail here as they would in the service.
 */
export const INVENTORY_DATABASE_URL =
  process.env.INVENTORY_TEST_DATABASE_URL ??
  `postgres://inventory:${process.env.INVENTORY_DB_PASSWORD ?? 'inventory_dev'}@127.0.0.1:${
    process.env.POSTGRES_HOST_PORT ?? '15432'
  }/inventory`;

/** Every inventory table, children before parents, for truncation. */
export const INVENTORY_TABLES = [
  'seat_occupation',
  'trip_seat',
  'trip_coach',
  'trip_stop',
  'inventory_trip',
  'processed_event',
  'outbox_event',
] as const;

let dataSource: DataSource | null = null;

async function assertDatabaseReachable(): Promise<void> {
  const url = new URL(INVENTORY_DATABASE_URL);
  // An absent port is ''; avoid converting it to 0 instead of the default port.
  await assertReachable('Postgres', url.hostname, Number(url.port || 5432));
}

/**
 * Reuse one connection per spec file and run migrations without booting a service.
 * TypeORM's ledger prevents applying migrations twice.
 */
export async function inventoryDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;

  await assertDatabaseReachable();

  dataSource = new DataSource({
    type: 'postgres',
    url: INVENTORY_DATABASE_URL,
    synchronize: false,
    migrations,
    entities: [
      InventoryTripEntity,
      TripStopEntity,
      TripCoachEntity,
      TripSeatEntity,
      SeatOccupationEntity,
    ],
    extra: { connectionTimeoutMillis: 5000 },
  });

  // Postgres can accept sockets before it is ready and then drop connections.
  // The probe catches missing containers; retries cover startup.
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

export async function closeInventoryDataSource(): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  dataSource = null;
}

/**
 * Truncate in one transaction. Caller-supplied UUIDs need no RESTART IDENTITY.
 */
export async function truncateInventory(source: DataSource): Promise<void> {
  await source.query(`TRUNCATE TABLE ${INVENTORY_TABLES.join(', ')} CASCADE`);
}
