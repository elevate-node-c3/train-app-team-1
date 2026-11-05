import { addCivilDays, cairoToday } from '@app/contracts';
import { DataSource } from 'typeorm';

import { SEARCH_FIXTURE, SEARCH_FIXTURE_IDS as IDS } from '../../../apps/catalog/src/database/seeds/search-fixture.js';

/**
 * Trips for the e2e tier, anchored to the real clock.
 *
 * The shared fixture dates its trips in June 2026, which the integration specs
 * can search because they pass a frozen `now`. The e2e tier cannot: it goes
 * through the real gateway, so a date in the past is simply refused as outside
 * the booking window. These trips are therefore placed relative to today.
 *
 * Everything date-independent -- stations, trains, classes, layouts,
 * timetables, fares -- is reused from the shared fixture, so only the dated
 * rows are duplicated here.
 */

const CATALOG_DATABASE_URL =
  process.env.CATALOG_TEST_DATABASE_URL ??
  `postgres://catalog:${process.env.CATALOG_DB_PASSWORD ?? 'catalog_dev'}@127.0.0.1:${
    process.env.POSTGRES_HOST_PORT ?? '15432'
  }/catalog`;

/** Ids clear of both the shared fixture's groups and the load spec's. */
function e2eUuid(group: number, item: number): string {
  return `0000${String(group).padStart(4, '0')}-0000-4000-8000-${String(
    item,
  ).padStart(12, '0')}`;
}

export interface E2eSearchFixture {
  /** A date three days out, comfortably inside the booking window. */
  searchDate: string;
  /** Today, in Cairo. */
  today: string;
  /** The first date past the window, which must be refused. */
  pastWindowDate: string;
  stations: typeof IDS.stations;
  travelClasses: typeof IDS.travelClasses;
  trainNumbers: { mainLine: number };
}

/**
 * Loads the network and a handful of trips relative to today.
 *
 * Writes through the published Postgres port rather than a container, which is
 * what `docker-compose.override.yml` publishes it for. The catalog service
 * reaches the same database as the same role from inside the network.
 */
export async function seedSearchE2e(): Promise<E2eSearchFixture> {
  const source = new DataSource({
    type: 'postgres',
    url: CATALOG_DATABASE_URL,
    synchronize: false,
    extra: { connectionTimeoutMillis: 5000 },
  });
  await source.initialize();

  const today = cairoToday(new Date());
  const searchDate = addCivilDays(today, 3);

  try {
    await insertNetwork(source);
    await insertDatedTrips(source, searchDate);

    return {
      searchDate,
      today,
      // today + 30 is the first day outside the 30-day window.
      pastWindowDate: addCivilDays(today, 30),
      stations: IDS.stations,
      travelClasses: IDS.travelClasses,
      trainNumbers: { mainLine: 903 },
    };
  } finally {
    await source.destroy();
  }
}

async function insert(
  source: DataSource,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;

  const placeholders = rows
    .map(
      (_, rowIndex) =>
        `(${columns
          .map(
            (_column, columnIndex) =>
              `$${rowIndex * columns.length + columnIndex + 1}`,
          )
          .join(', ')})`,
    )
    .join(', ');

  await source.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}
     ON CONFLICT (id) DO NOTHING`,
    rows.flat(),
  );
}

/** The date-independent half, straight from the shared fixture. */
async function insertNetwork(source: DataSource): Promise<void> {
  const f = SEARCH_FIXTURE;

  await insert(
    source,
    'governorate',
    ['id', 'name_ar', 'name_en', 'sort_order'],
    f.governorates.map((r) => [r.id, r.nameAr, r.nameEn, r.sortOrder]),
  );
  await insert(
    source,
    'city',
    ['id', 'governorate_id', 'name_ar', 'name_en'],
    f.cities.map((r) => [r.id, r.governorateId, r.nameAr, r.nameEn]),
  );
  await insert(
    source,
    'station',
    ['id', 'city_id', 'name_ar', 'name_en', 'alt_spellings', 'is_active'],
    f.stations.map((r) => [
      r.id,
      r.cityId,
      r.nameAr,
      r.nameEn,
      r.altSpellings,
      r.isActive,
    ]),
  );
  await insert(
    source,
    'train_type',
    ['id', 'name_ar', 'name_en'],
    f.trainTypes.map((r) => [r.id, r.nameAr, r.nameEn]),
  );
  await insert(
    source,
    'travel_class',
    ['id', 'name_ar', 'name_en'],
    f.travelClasses.map((r) => [r.id, r.nameAr, r.nameEn]),
  );
  await insert(
    source,
    'coach_layout',
    ['id', 'layout_name', 'rows'],
    f.coachLayouts.map((r) => [r.id, r.layoutName, JSON.stringify(r.rows)]),
  );
  await insert(
    source,
    'train',
    ['id', 'train_number', 'train_type_id'],
    f.trains.map((r) => [r.id, r.trainNumber, r.trainTypeId]),
  );
  await insert(
    source,
    'train_coach',
    [
      'id',
      'train_id',
      'position',
      'coach_number',
      'travel_class_id',
      'coach_layout_id',
    ],
    f.trainCoaches.map((r) => [
      r.id,
      r.trainId,
      r.position,
      r.coachNumber,
      r.travelClassId,
      r.coachLayoutId,
    ]),
  );
  await insert(
    source,
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
    f.timetables.map((r) => [
      r.id,
      r.trainId,
      r.runningDays,
      r.effectiveFrom,
      r.effectiveUntil,
      r.version,
      r.status,
    ]),
  );
  await insert(
    source,
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
    f.timetableStops.map((r) => [
      r.id,
      r.timetableId,
      r.stationId,
      r.position,
      r.dayOffset,
      r.arrivalTime,
      r.departureTime,
    ]),
  );
  await insert(
    source,
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
    f.fares.map((r) => [
      r.id,
      r.trainId,
      r.travelClassId,
      r.originStationId,
      r.destinationStationId,
      r.amountPiastres,
      r.effectiveFrom,
    ]),
  );
}

/**
 * The main-line trip, on a date three days out.
 *
 * Times carry an explicit Cairo offset so the instants are unambiguous
 * whatever the host's zone, and the response's local times are predictable.
 */
async function insertDatedTrips(
  source: DataSource,
  serviceDate: string,
): Promise<void> {
  const tripId = e2eUuid(80, 1);
  const offset = cairoOffsetOn(serviceDate);
  const at = (time: string) => new Date(`${serviceDate}T${time}:00${offset}`);

  const snapshot = SEARCH_FIXTURE.datedTrips.find(
    (trip) => trip.id === IDS.trips.mainLine,
  )!.compositionSnapshot;

  await insert(
    source,
    'dated_trip',
    [
      'id',
      'train_id',
      'timetable_id',
      'service_date',
      'timetable_version',
      'composition_snapshot',
      'status',
    ],
    [
      [
        tripId,
        IDS.trains.mainLine,
        IDS.timetables.mainLine,
        serviceDate,
        1,
        JSON.stringify(snapshot),
        'published',
      ],
    ],
  );

  const schedule: [string, string | null, string | null][] = [
    [IDS.stations.alexandria, null, '06:00'],
    [IDS.stations.tanta, '07:00', '07:05'],
    [IDS.stations.banha, '07:45', '07:50'],
    [IDS.stations.ramsis, '08:40', '08:50'],
    [IDS.stations.giza, '09:10', '09:15'],
    [IDS.stations.assiut, '13:30', '13:40'],
    [IDS.stations.aswan, '18:00', null],
  ];

  await insert(
    source,
    'trip_stop',
    ['id', 'trip_id', 'station_id', 'position', 'arrival_at', 'departure_at'],
    schedule.map(([stationId, arrival, departure], index) => [
      e2eUuid(81, index + 1),
      tripId,
      stationId,
      index + 1,
      arrival === null ? null : at(arrival),
      departure === null ? null : at(departure),
    ]),
  );
}

/** Cairo's offset on a civil date, read from tzdata rather than guessed. */
function cairoOffsetOn(civilDate: string): string {
  const midday = new Date(`${civilDate}T12:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    timeZoneName: 'longOffset',
  })
    .formatToParts(midday)
    .find((part) => part.type === 'timeZoneName')?.value;

  return (name ?? 'GMT+02:00').replace('GMT', '') || '+02:00';
}
