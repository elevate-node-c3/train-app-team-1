import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DataSource } from 'typeorm';

import dataSource from '../data-source.js';
import { SEARCH_FIXTURE } from './search-fixture.js';

/**
 * Loads the search fixture into the catalog database.
 *
 * It writes `dated_trip` and `trip_stop` directly, standing in for TA-16's
 * generator so the search path can be exercised end to end before that lands.
 * Idempotent: every row is keyed by a fixed uuid and conflicts are ignored, so
 * running it twice is a no-op rather than a duplicate-key failure.
 */

const TABLE_WAIT_TIMEOUT_MS = 60_000;
const TABLE_POLL_INTERVAL_MS = 250;

/**
 * Catalog runs its migrations during `onApplicationBootstrap`, so a separate
 * seed process cannot assume `dated_trip` exists yet. Poll with a bound rather
 * than sleeping a fixed amount and hoping.
 */
async function waitForTripTable(source: DataSource): Promise<void> {
  const deadline = Date.now() + TABLE_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const rows = (await source.query(
      "SELECT to_regclass('public.dated_trip') AS name",
    )) as { name: string | null }[];
    if (rows[0]?.name) return;
    await new Promise((settle) => setTimeout(settle, TABLE_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out after ${TABLE_WAIT_TIMEOUT_MS}ms waiting for catalog's dated_trip table; run catalog's migrations first`,
  );
}

/**
 * Inserts rows, ignoring any whose id is already present.
 *
 * One statement per table rather than per row: a fixture is a few dozen rows,
 * and a loop would turn the seed into a few dozen round trips.
 */
async function insertAll(
  source: DataSource,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<number> {
  if (rows.length === 0) return 0;

  const placeholders = rows
    .map(
      (_, rowIndex) =>
        `(${columns
          .map((_column, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`)
          .join(', ')})`,
    )
    .join(', ');

  const inserted = (await source.query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES ${placeholders}
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    rows.flat(),
  )) as { id: string }[];

  return inserted.length;
}

async function seed(): Promise<void> {
  let initialized = false;

  try {
    await dataSource.initialize();
    initialized = true;
    await waitForTripTable(dataSource);

    const counts: [string, number][] = [];

    counts.push([
      'governorate',
      await insertAll(
        dataSource,
        'governorate',
        ['id', 'name_ar', 'name_en', 'sort_order'],
        SEARCH_FIXTURE.governorates.map((row) => [
          row.id,
          row.nameAr,
          row.nameEn,
          row.sortOrder,
        ]),
      ),
    ]);

    counts.push([
      'city',
      await insertAll(
        dataSource,
        'city',
        ['id', 'governorate_id', 'name_ar', 'name_en'],
        SEARCH_FIXTURE.cities.map((row) => [
          row.id,
          row.governorateId,
          row.nameAr,
          row.nameEn,
        ]),
      ),
    ]);

    counts.push([
      'station',
      await insertAll(
        dataSource,
        'station',
        ['id', 'city_id', 'name_ar', 'name_en', 'alt_spellings', 'is_active'],
        SEARCH_FIXTURE.stations.map((row) => [
          row.id,
          row.cityId,
          row.nameAr,
          row.nameEn,
          row.altSpellings,
          row.isActive,
        ]),
      ),
    ]);

    counts.push([
      'train_type',
      await insertAll(
        dataSource,
        'train_type',
        ['id', 'name_ar', 'name_en'],
        SEARCH_FIXTURE.trainTypes.map((row) => [row.id, row.nameAr, row.nameEn]),
      ),
    ]);

    counts.push([
      'travel_class',
      await insertAll(
        dataSource,
        'travel_class',
        ['id', 'name_ar', 'name_en'],
        SEARCH_FIXTURE.travelClasses.map((row) => [
          row.id,
          row.nameAr,
          row.nameEn,
        ]),
      ),
    ]);

    counts.push([
      'coach_layout',
      await insertAll(
        dataSource,
        'coach_layout',
        ['id', 'layout_name', 'rows'],
        SEARCH_FIXTURE.coachLayouts.map((row) => [
          row.id,
          row.layoutName,
          JSON.stringify(row.rows),
        ]),
      ),
    ]);

    counts.push([
      'train',
      await insertAll(
        dataSource,
        'train',
        ['id', 'train_number', 'train_type_id'],
        SEARCH_FIXTURE.trains.map((row) => [
          row.id,
          row.trainNumber,
          row.trainTypeId,
        ]),
      ),
    ]);

    counts.push([
      'train_coach',
      await insertAll(
        dataSource,
        'train_coach',
        [
          'id',
          'train_id',
          'position',
          'coach_number',
          'travel_class_id',
          'coach_layout_id',
        ],
        SEARCH_FIXTURE.trainCoaches.map((row) => [
          row.id,
          row.trainId,
          row.position,
          row.coachNumber,
          row.travelClassId,
          row.coachLayoutId,
        ]),
      ),
    ]);

    counts.push([
      'timetable',
      await insertAll(
        dataSource,
        'timetable',
        [
          'id',
          'train_id',
          'running_days',
          'effective_from',
          'effective_until',
          'version',
          'status',
        ],
        SEARCH_FIXTURE.timetables.map((row) => [
          row.id,
          row.trainId,
          row.runningDays,
          row.effectiveFrom,
          row.effectiveUntil,
          row.version,
          row.status,
        ]),
      ),
    ]);

    counts.push([
      'timetable_stop',
      await insertAll(
        dataSource,
        'timetable_stop',
        [
          'id',
          'timetable_id',
          'station_id',
          'position',
          'day_offset',
          'arrival_time',
          'departure_time',
        ],
        SEARCH_FIXTURE.timetableStops.map((row) => [
          row.id,
          row.timetableId,
          row.stationId,
          row.position,
          row.dayOffset,
          row.arrivalTime,
          row.departureTime,
        ]),
      ),
    ]);

    counts.push([
      'fare',
      await insertAll(
        dataSource,
        'fare',
        [
          'id',
          'train_id',
          'travel_class_id',
          'origin_station_id',
          'destination_station_id',
          'amount_piastres',
          'effective_from',
        ],
        SEARCH_FIXTURE.fares.map((row) => [
          row.id,
          row.trainId,
          row.travelClassId,
          row.originStationId,
          row.destinationStationId,
          row.amountPiastres,
          row.effectiveFrom,
        ]),
      ),
    ]);

    counts.push([
      'dated_trip',
      await insertAll(
        dataSource,
        'dated_trip',
        [
          'id',
          'train_id',
          'timetable_id',
          'service_date',
          'timetable_version',
          'composition_snapshot',
          'status',
          'published_at',
        ],
        SEARCH_FIXTURE.datedTrips.map((row) => [
          row.id,
          row.trainId,
          row.timetableId,
          row.serviceDate,
          row.timetableVersion,
          JSON.stringify(row.compositionSnapshot),
          row.status,
          row.publishedAt,
        ]),
      ),
    ]);

    counts.push([
      'trip_stop',
      await insertAll(
        dataSource,
        'trip_stop',
        ['id', 'trip_id', 'station_id', 'position', 'arrival_at', 'departure_at'],
        SEARCH_FIXTURE.tripStops.map((row) => [
          row.id,
          row.tripId,
          row.stationId,
          row.position,
          row.arrivalAt,
          row.departureAt,
        ]),
      ),
    ]);

    for (const [table, inserted] of counts) {
      console.log(
        inserted > 0
          ? `seed: ${table} +${inserted}`
          : `seed: ${table} already present`,
      );
    }
  } finally {
    if (initialized && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    import.meta.url === pathToFileURL(resolve(entry)).href
  );
}

if (isEntrypoint()) {
  seed().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`seed: ${message}`);
    process.exitCode = 1;
  });
}

export { seed as seedSearchFixture };
