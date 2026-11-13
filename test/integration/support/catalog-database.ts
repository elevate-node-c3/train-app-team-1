import { DataSource } from 'typeorm';

import { migrations } from '../../../apps/catalog/src/database/migrations/index.js';
import { CityEntity } from '../../../apps/catalog/src/modules/stations/entities/city.entity.js';
import { CoachLayoutEntity } from '../../../apps/catalog/src/modules/trains/entities/coach-layout.entity.js';
import { DatedTripEntity } from '../../../apps/catalog/src/modules/trips/entities/dated-trip.entity.js';
import { FareEntity } from '../../../apps/catalog/src/modules/fares/entities/fare.entity.js';
import { GovernorateEntity } from '../../../apps/catalog/src/modules/stations/entities/governorate.entity.js';
import { OperationsAuditEntity } from '../../../apps/catalog/src/modules/operations/entities/operations-audit.entity.js';
import { OperationsRequestEntity } from '../../../apps/catalog/src/modules/operations/entities/operations-request.entity.js';
import { RecentSearchEntity } from '../../../apps/catalog/src/modules/recent-searches/entities/recent-search.entity.js';
import { StationEntity } from '../../../apps/catalog/src/modules/stations/entities/station.entity.js';
import { TimetableEntity } from '../../../apps/catalog/src/modules/timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../../../apps/catalog/src/modules/timetables/entities/timetable-stop.entity.js';
import { TrainCoachEntity } from '../../../apps/catalog/src/modules/trains/entities/train-coach.entity.js';
import { TrainEntity } from '../../../apps/catalog/src/modules/trains/entities/train.entity.js';
import { TrainTypeEntity } from '../../../apps/catalog/src/modules/trains/entities/train-type.entity.js';
import { TravelClassEntity } from '../../../apps/catalog/src/modules/trains/entities/travel-class.entity.js';
import { TripStopEntity } from '../../../apps/catalog/src/modules/trips/entities/trip-stop.entity.js';

/**
 * Use the override's host port and catalog role, not the superuser,
 * so missing grants fail here as they would in the service.
 */
export const CATALOG_DATABASE_URL =
  process.env.CATALOG_TEST_DATABASE_URL ??
  `postgres://catalog:${process.env.CATALOG_DB_PASSWORD ?? 'catalog_dev'}@127.0.0.1:${
    process.env.POSTGRES_HOST_PORT ?? '15432'
  }/catalog`;

/** Every catalog table, children before parents, for truncation. */
export const CATALOG_TABLES = [
  'recent_search',
  'trip_stop',
  'dated_trip',
  'fare',
  'timetable_stop',
  'timetable',
  'train_coach',
  'train',
  'train_type',
  'travel_class',
  'coach_layout',
  'station',
  'city',
  'governorate',
] as const;

let dataSource: DataSource | null = null;

/**
 * Fail fast with startup instructions for Postgres and Redis. Driver retries
 * otherwise delay failure and make tests look skipped when beforeAll throws.
 * The e2e tier removes containers and volumes with compose down -v.
 */
export async function assertReachable(
  label: string,
  hostname: string,
  port: number,
): Promise<void> {
  const { Socket } = await import('node:net');

  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    const fail = (): void => {
      socket.destroy();
      reject(
        new Error(
          [
            `Cannot reach ${label} at ${hostname}:${port} for the integration tier.`,
            '',
            'Start it with:  docker compose up -d postgres redis',
            'Then migrate:   DATABASE_URL=postgres://catalog:catalog_dev@127.0.0.1:15432/catalog npm run catalog:migration:run',
            '',
            'The e2e tier ends with `compose down -v`, which removes both the',
            'containers and their volumes, so this is expected after running it.',
          ].join('\n'),
        ),
      );
    };

    socket.setTimeout(2000);
    socket.once('error', fail);
    socket.once('timeout', fail);
    socket.connect(port, hostname, () => {
      socket.end();
      resolve();
    });
  });
}

async function assertDatabaseReachable(): Promise<void> {
  const url = new URL(CATALOG_DATABASE_URL);
  // An absent port is ''; avoid converting it to 0 instead of the default port.
  await assertReachable('Postgres', url.hostname, Number(url.port || 5432));
}

/**
 * Reuse one connection per spec file and run migrations without booting a service.
 * TypeORM's ledger prevents applying migrations twice.
 */
export async function catalogDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;

  await assertDatabaseReachable();

  dataSource = new DataSource({
    type: 'postgres',
    url: CATALOG_DATABASE_URL,
    synchronize: false,
    migrations,
    entities: [
      GovernorateEntity,
      CityEntity,
      StationEntity,
      TrainTypeEntity,
      TrainEntity,
      TravelClassEntity,
      CoachLayoutEntity,
      TrainCoachEntity,
      TimetableEntity,
      TimetableStopEntity,
      FareEntity,
      DatedTripEntity,
      TripStopEntity,
      RecentSearchEntity,
      OperationsAuditEntity,
      OperationsRequestEntity,
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

export async function closeCatalogDataSource(): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  dataSource = null;
}

/**
 * Count statements with TypeORM's logger to check bounded query counts directly,
 * rather than inferring them from timings or database-wide statistics.
 */
export async function countStatements<T>(
  source: DataSource,
  work: () => Promise<T>,
): Promise<{ result: T; queries: string[] }> {
  const queries: string[] = [];
  const original = source.logger;

  source.logger = {
    ...original,
    logQuery(query: string) {
      queries.push(query);
    },
  };

  try {
    const result = await work();
    return { result, queries };
  } finally {
    source.logger = original;
  }
}

/**
 * Truncate in one transaction. Caller-supplied UUIDs need no RESTART IDENTITY.
 */
export async function truncateCatalog(source: DataSource): Promise<void> {
  await source.query(`TRUNCATE TABLE ${CATALOG_TABLES.join(', ')} CASCADE`);
}
