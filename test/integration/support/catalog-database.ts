import { DataSource } from 'typeorm';

import { migrations } from '../../../apps/catalog/src/database/migrations/index.js';
import { CityEntity } from '../../../apps/catalog/src/modules/stations/entities/city.entity.js';
import { CoachLayoutEntity } from '../../../apps/catalog/src/modules/trains/entities/coach-layout.entity.js';
import { DatedTripEntity } from '../../../apps/catalog/src/modules/trips/entities/dated-trip.entity.js';
import { FareEntity } from '../../../apps/catalog/src/modules/fares/entities/fare.entity.js';
import { GovernorateEntity } from '../../../apps/catalog/src/modules/stations/entities/governorate.entity.js';
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
 * Without this, a stopped container produces thirty seconds of ioredis retry
 * warnings and then reports every test as *skipped* -- because `beforeAll`
 * threw -- which reads like "nothing to run" rather than "start the database".
 * The exit code is still non-zero, so a gate catches it; a person reading the
 * output is the one who was being misled. The e2e tier tears the stack down
 * with `compose down -v`, so this is the normal way to arrive here.
 */
async function assertDatabaseReachable(): Promise<void> {
  const url = new URL(CATALOG_DATABASE_URL);
  const { Socket } = await import('node:net');

  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    const fail = (): void => {
      socket.destroy();
      reject(
        new Error(
          [
            `Cannot reach Postgres at ${url.host} for the integration tier.`,
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
    socket.connect(Number(url.port), url.hostname, () => {
      socket.end();
      resolve();
    });
  });
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
    ],
    extra: { connectionTimeoutMillis: 5000 },
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  return dataSource;
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
