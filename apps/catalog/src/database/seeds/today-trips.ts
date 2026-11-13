import { addCivilDays, cairoToday } from '@app/contracts';
import { DataSource } from 'typeorm';

import { seedDatabaseUrlFromEnv } from '../../config/database-settings.js';
import { SEARCH_FIXTURE, SEARCH_FIXTURE_IDS as IDS } from './search-fixture.js';

/**
 * E2e uses the real clock, so place trips inside today's booking window rather
 * than using the frozen June fixture. Reuse its date-independent network data.
 */

const CATALOG_DATABASE_URL = seedDatabaseUrlFromEnv();

/** Keep IDs separate from the shared fixture and load specs. */
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

/** Reset latest-five search assertions without reseeding trips. */
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

/** Use explicit Cairo offsets so the host timezone cannot change seeded instants. */
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
 * Use Tanta -> Ramsis to leave Alexandria's single-trip assertions unchanged.
 * Price both train types; unpriced trips are unsellable. The later sleeper costs
 * more than the express, giving fare sorts and filters distinct results.
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
      [
        e2eUuid(84, 1),
        IDS.trains.mainLine,
        IDS.travelClasses.first,
        IDS.stations.tanta,
        IDS.stations.ramsis,
        9_000,
        new Date('2026-01-01T00:00:00Z'),
      ],
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
 * The 06:30 same-day return leaves before the 08:40 outbound arrival; two trips
 * on the later return date leave after it. Use separate trains for same-date
 * trips to satisfy train/date uniqueness.
 * Keep timetable stops for empty-result probes, which check reverse service
 * even when no dated return matches.
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
        [
          e2eUuid(89, index * 2 + 1),
          tripId,
          IDS.stations.ramsis,
          1,
          null,
          at(departure),
        ],
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
  // Normalize ICU's '+3' to '+03:00' to avoid invalid seeded dates.
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  if (!match) return '+02:00';

  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${hours.padStart(2, '0')}:${minutes}`;
}
