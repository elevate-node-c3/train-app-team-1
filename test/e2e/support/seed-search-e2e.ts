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
  /** Two days after that: the return date for the round-trip flow. */
  returnDate: string;
  /** Today, in Cairo. */
  today: string;
  /** The first date past the window, which must be refused. */
  pastWindowDate: string;
  stations: typeof IDS.stations;
  travelClasses: typeof IDS.travelClasses;
  trainTypes: typeof IDS.trainTypes;
  trainNumbers: { mainLine: number; sleeper: number; returning: number };
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
  const returnDate = addCivilDays(searchDate, 2);

  try {
    await insertNetwork(source);
    await insertDatedTrips(source, searchDate);
    await insertFilterPairTrips(source, searchDate);
    await insertReturnTrips(source, searchDate, returnDate);

    return {
      searchDate,
      returnDate,
      today,
      // today + 30 is the first day outside the 30-day window.
      pastWindowDate: addCivilDays(today, 30),
      stations: IDS.stations,
      travelClasses: IDS.travelClasses,
      trainTypes: IDS.trainTypes,
      trainNumbers: { mainLine: 903, sleeper: 980, returning: 904 },
    };
  } finally {
    await source.destroy();
  }
}

/**
 * Empties the recent-search table.
 *
 * "The last five, newest first" is a count, so a suite asserting on it has to
 * know where the count started. Separate from the seed because the searches
 * that fill it are made by the specs, not by the fixture, and a suite that
 * runs after another one's searches needs to reset without re-seeding trips.
 */
export async function clearRecentSearches(): Promise<void> {
  const source = new DataSource({
    type: 'postgres',
    url: CATALOG_DATABASE_URL,
    synchronize: false,
    extra: { connectionTimeoutMillis: 5000 },
  });
  await source.initialize();

  try {
    await source.query('DELETE FROM recent_search');
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

/**
 * A day with two train types on one pair, for the filters to choose between.
 *
 * Deliberately on **Tanta -> Ramsis**, not the Alexandria -> Ramsis pair the
 * TA-17 specs use: those assert that the day holds exactly one trip, and that
 * is a real assertion about the one-way search rather than a detail of the
 * fixture. Adding a second trip there would have made me weaken them.
 *
 * Tanta -> Ramsis already has the main line (07:05 -> 08:40) but no fare, so
 * both fares are added here too -- an unpriced trip is dropped as unsellable,
 * which would leave the pair with one result and nothing to filter. The
 * sleeper is dearer, so the fare sort and the maximum-fare filter both have an
 * order to produce.
 */
async function insertFilterPairTrips(
  source: DataSource,
  serviceDate: string,
): Promise<void> {
  const tripId = e2eUuid(82, 1);
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
        IDS.trains.overnight,
        IDS.timetables.overnight,
        serviceDate,
        1,
        JSON.stringify(snapshot),
        'published',
      ],
    ],
  );

  await insert(
    source,
    'trip_stop',
    ['id', 'trip_id', 'station_id', 'position', 'arrival_at', 'departure_at'],
    [
      [e2eUuid(83, 1), tripId, IDS.stations.tanta, 1, null, at('10:00')],
      [e2eUuid(83, 2), tripId, IDS.stations.banha, 2, at('11:00'), at('11:05')],
      [e2eUuid(83, 3), tripId, IDS.stations.ramsis, 3, at('13:00'), null],
    ],
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
    [
      // The cheap one: express, leaving in the morning.
      [
        e2eUuid(84, 1),
        IDS.trains.mainLine,
        IDS.travelClasses.first,
        IDS.stations.tanta,
        IDS.stations.ramsis,
        9_000,
        new Date('2026-01-01T00:00:00Z'),
      ],
      // The dear one: sleeper, leaving later.
      [
        e2eUuid(84, 2),
        IDS.trains.overnight,
        IDS.travelClasses.first,
        IDS.stations.tanta,
        IDS.stations.ramsis,
        25_000,
        new Date('2026-01-01T00:00:00Z'),
      ],
    ],
  );
}

/**
 * The reverse route, so a round trip has a second list.
 *
 * Three trips across two dates, each on its own train because `dated_trip` is
 * unique on (train_id, service_date):
 *
 * - one on the OUTBOUND date, departing 06:30 -- before the outbound trip
 *   reaches Ramsis at 08:40, so a same-day return finds only a train that has
 *   already gone. That is the story's "nothing leaves after your outbound
 *   arrives" case, reachable without a 23:50 trip.
 * - two on the return date, which any outbound arrival precedes.
 *
 * The timetable stops matter even though search reads `trip_stop`: the
 * empty-result probes ask the timetables whether the reverse pair is served at
 * all, and without them an empty return list would blame the stations.
 */
async function insertReturnTrips(
  source: DataSource,
  outboundDate: string,
  returnDate: string,
): Promise<void> {
  const trains = [
    { id: e2eUuid(85, 1), number: 904, timetableId: e2eUuid(86, 1) },
    { id: e2eUuid(85, 2), number: 905, timetableId: e2eUuid(86, 2) },
  ];

  await insert(
    source,
    'train',
    ['id', 'train_number', 'train_type_id'],
    trains.map((train) => [train.id, train.number, IDS.trainTypes.express]),
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
    trains.map((train) => [
      train.timetableId,
      train.id,
      [0, 1, 2, 3, 4, 5, 6],
      '2026-01-01',
      null,
      1,
      'published',
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
    trains.flatMap((train, index) => [
      [
        e2eUuid(87, index * 2 + 1),
        train.timetableId,
        IDS.stations.ramsis,
        1,
        0,
        null,
        '09:00',
      ],
      [
        e2eUuid(87, index * 2 + 2),
        train.timetableId,
        IDS.stations.alexandria,
        2,
        0,
        '12:00',
        null,
      ],
    ]),
  );

  const snapshot = JSON.stringify(
    SEARCH_FIXTURE.datedTrips.find((trip) => trip.id === IDS.trips.mainLine)!
      .compositionSnapshot,
  );

  // [train, service date, departure, arrival]
  const runs: [(typeof trains)[number], string, string, string][] = [
    [trains[0], outboundDate, '06:30', '09:30'],
    [trains[0], returnDate, '09:00', '12:00'],
    [trains[1], returnDate, '18:00', '21:00'],
  ];

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
    runs.map(([train, date], index) => [
      e2eUuid(88, index + 1),
      train.id,
      train.timetableId,
      date,
      1,
      snapshot,
      'published',
    ]),
  );

  await insert(
    source,
    'trip_stop',
    ['id', 'trip_id', 'station_id', 'position', 'arrival_at', 'departure_at'],
    runs.flatMap(([, date, departure, arrival], index) => {
      const offset = cairoOffsetOn(date);
      const at = (time: string) => new Date(`${date}T${time}:00${offset}`);
      const tripId = e2eUuid(88, index + 1);

      return [
        [e2eUuid(89, index * 2 + 1), tripId, IDS.stations.ramsis, 1, null, at(departure)],
        [
          e2eUuid(89, index * 2 + 2),
          tripId,
          IDS.stations.alexandria,
          2,
          at(arrival),
          null,
        ],
      ];
    }),
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
    trains.map((train, index) => [
      e2eUuid(84, index + 3),
      train.id,
      IDS.travelClasses.first,
      IDS.stations.ramsis,
      IDS.stations.alexandria,
      14_000,
      new Date('2026-01-01T00:00:00Z'),
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

  const raw = (name ?? '').replace('GMT', '').trim();
  // ICU may spell it '+3' rather than '+03:00', and '+3' is not a valid ISO
  // offset -- `new Date('...T06:00:00+3')` is an Invalid Date, which would
  // seed null instants and fail far from the cause.
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  if (!match) return '+02:00';

  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${hours.padStart(2, '0')}:${minutes}`;
}
