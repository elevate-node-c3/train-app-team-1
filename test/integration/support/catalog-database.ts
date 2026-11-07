import { DataSource } from 'typeorm';

import { migrations } from '../../../apps/catalog/src/database/migrations/index.js';
import { CityEntity } from '../../../apps/catalog/src/modules/stations/entities/city.entity.js';
import { CoachLayoutEntity } from '../../../apps/catalog/src/modules/trains/entities/coach-layout.entity.js';
import { DatedTripEntity } from '../../../apps/catalog/src/modules/trips/entities/dated-trip.entity.js';
import { FareEntity } from '../../../apps/catalog/src/modules/fares/entities/fare.entity.js';
import { GovernorateEntity } from '../../../apps/catalog/src/modules/stations/entities/governorate.entity.js';
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
 * The catalog database, as an integration spec on the host sees it.
 *
 * Reached through the port `docker-compose.override.yml` publishes, and as the
 * `catalog` login role rather than the superuser -- so a spec that would fail
 * on a missing grant fails here too, rather than passing locally and breaking
 * in the container.
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
 * Fails fast, and says what to do about it.
 *
 * Without this, a stopped container produces around thirty seconds of driver
 * retry warnings and then reports every test as *skipped* -- because
 * `beforeAll` threw -- which reads like "nothing to run" rather than "start
 * the database". The exit code is still non-zero, so a gate catches it; the
 * person reading the output is the one being misled. The e2e tier ends with
 * `compose down -v`, so this is the normal way to arrive here.
 *
 * Exported because Redis needs the same treatment for the same reason.
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
  // An absent port parses as '', and Number('') is 0 -- which would report
  // Postgres unreachable when it is merely on the default port.
  await assertReachable('Postgres', url.hostname, Number(url.port || 5432));
}

/**
 * Opens the connection once per spec file and applies migrations.
 *
 * Migrations are idempotent through TypeORM's own ledger, so a second call is
 * cheap; the service normally runs them at bootstrap, and nothing boots here.
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
    ],
    extra: { connectionTimeoutMillis: 5000 },
  });

  // A listening socket is not a ready server: Postgres accepts connections
  // during start-up and then drops them with "Connection terminated
  // unexpectedly". The socket probe above is for "the container is gone"; this
  // short retry is for "it is still waking up", which is what `docker compose
  // up -d` immediately followed by a test run looks like.
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
 * Counts the statements a block of work sends to Postgres.
 *
 * TA-28 asks that the query count stay bounded as the result count grows, and
 * that is only an assertion if something counts. TypeORM's logger sees every
 * statement a `DataSource` issues, so swapping one in for the duration of a
 * call measures it directly rather than inferring it from timings or from
 * `pg_stat_database` deltas.
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
 * Empties every catalog table.
 *
 * One statement so it is one transaction, and RESTART IDENTITY is deliberately
 * absent -- every primary key in this schema is a caller-supplied uuid, so
 * there is no sequence to reset.
 */
export async function truncateCatalog(source: DataSource): Promise<void> {
  await source.query(`TRUNCATE TABLE ${CATALOG_TABLES.join(', ')} CASCADE`);
}
