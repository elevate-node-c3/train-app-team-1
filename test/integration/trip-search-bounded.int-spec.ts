import { SEARCH_FIXTURE_IDS as IDS } from '../../apps/catalog/src/database/seeds/search-fixture.js';
import { seedSearchFixture } from '../../apps/catalog/src/database/seeds/search-fixture.seed.js';
import { buildTripList } from '../../apps/catalog/src/modules/trips/trip-result.js';
import { searchCacheKey } from '../../apps/catalog/src/modules/trips/trip-search-cache.js';
import { TripSearchRepository } from '../../apps/catalog/src/modules/trips/trip-search.repository.js';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
  countStatements,
} from './support/catalog-database.js';

/**
 * Measure one ordered, complete day query before and after adding 30 trips.
 * The statement count must stay fixed as results grow.
 */

const NOW = new Date('2026-06-15T09:00:00Z');
const EXTRA_TRIPS = 30;

/** Use IDs outside the fixture's groups. */
function loadUuid(group: number, item: number): string {
  return `0000${String(group).padStart(4, '0')}-0000-4000-8000-${String(
    item,
  ).padStart(12, '0')}`;
}

/**
 * Each load trip needs its own train for unique (train_id, service_date),
 * and its own timetable for unique (train_id, version). All share a route
 * pair and date.
 */
async function addManyTrips(source: DataSource, count: number): Promise<void> {
  const snapshot = JSON.stringify([
    {
      position: 1,
      coachNumber: 1,
      travelClass: {
        id: IDS.travelClasses.first,
        nameEn: 'First Class',
        nameAr: 'الدرجة الأولى',
      },
      coachLayout: {
        id: IDS.coachLayouts.first,
        layoutName: 'load-2-2-1',
        rows: [{ rowNumber: 1, leftSeats: ['L1', 'L2'], rightSeats: ['R1', 'R2'] }],
      },
    },
  ]);

  for (let index = 0; index < count; index += 1) {
    const trainId = loadUuid(90, index + 1);
    const timetableId = loadUuid(91, index + 1);
    const tripId = loadUuid(92, index + 1);
    // Vary departures so sorting is exercised.
    const minute = String(index % 60).padStart(2, '0');
    const hour = String(6 + Math.floor(index / 60)).padStart(2, '0');

    await source.query(
      `INSERT INTO train (id, train_number, train_type_id) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [trainId, 9000 + index, IDS.trainTypes.express],
    );
    await source.query(
      `INSERT INTO timetable (id, train_id, running_days, effective_from, version, status)
       VALUES ($1, $2, ARRAY[0,1,2,3,4,5,6]::smallint[], '2026-01-01', 1, 'published')
       ON CONFLICT (id) DO NOTHING`,
      [timetableId, trainId],
    );
    await source.query(
      `INSERT INTO dated_trip (id, train_id, timetable_id, service_date, timetable_version, composition_snapshot, status)
       VALUES ($1, $2, $3, '2026-06-20', 1, $4::jsonb, 'published')
       ON CONFLICT (id) DO NOTHING`,
      [tripId, trainId, timetableId, snapshot],
    );
    await source.query(
      `INSERT INTO trip_stop (id, trip_id, station_id, position, arrival_at, departure_at)
       VALUES ($1, $2, $3, 1, NULL, $5),
              ($4, $2, $6, 2, $7, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        loadUuid(93, index * 2 + 1),
        tripId,
        IDS.stations.alexandria,
        loadUuid(93, index * 2 + 2),
        new Date(`2026-06-20T${hour}:${minute}:00+03:00`),
        IDS.stations.ramsis,
        new Date(`2026-06-20T1${hour.slice(1)}:${minute}:00+03:00`),
      ],
    );
    await source.query(
      `INSERT INTO fare (id, train_id, travel_class_id, origin_station_id, destination_station_id, amount_piastres, effective_from)
       VALUES ($1, $2, $3, $4, $5, 10000, '2026-01-01T00:00:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [
        loadUuid(94, index + 1),
        trainId,
        IDS.travelClasses.first,
        IDS.stations.alexandria,
        IDS.stations.ramsis,
      ],
    );
  }
}

/**
 * Clear load trips before reruns so idempotent inserts produce measurable
 * growth, even when the database persists. Delete children before parents,
 * one table per statement.
 */
async function removeManyTrips(source: DataSource): Promise<void> {
  await source.query(
    `DELETE FROM trip_stop WHERE trip_id IN (SELECT id FROM dated_trip WHERE train_id IN (SELECT id FROM train WHERE train_number >= 9000))`,
  );
  await source.query(
    `DELETE FROM dated_trip WHERE train_id IN (SELECT id FROM train WHERE train_number >= 9000)`,
  );
  await source.query(
    `DELETE FROM fare WHERE train_id IN (SELECT id FROM train WHERE train_number >= 9000)`,
  );
  await source.query(
    `DELETE FROM timetable WHERE train_id IN (SELECT id FROM train WHERE train_number >= 9000)`,
  );
  await source.query(`DELETE FROM train WHERE train_number >= 9000`);
}

describe('search stays bounded and complete (TA-28)', () => {
  let source: DataSource;
  let repository: TripSearchRepository;

  beforeAll(async () => {
    source = await catalogDataSource();
    await seedSearchFixture(source);
    await removeManyTrips(source);
    repository = new TripSearchRepository(source);
  });

  afterAll(async () => {
    // Remove extra Alexandria-Ramsis trips so other specs keep their fixture counts.
    await removeManyTrips(source);
    await closeCatalogDataSource();
  });

  const search = () =>
    repository.findCandidates({
      originStationId: IDS.stations.alexandria,
      destinationStationId: IDS.stations.ramsis,
      travelClassId: IDS.travelClasses.first,
      serviceDate: '2026-06-20',
      trainNumber: null,
      now: NOW,
    });

  it('finds a day of trips in exactly one statement', async () => {
    const { result, queries } = await countStatements(source, search);

    expect(result.length).toBeGreaterThan(0);
    expect(queries).toHaveLength(1);
  });

  it('still takes one statement when the result set grows thirtyfold', async () => {
    const before = await countStatements(source, search);

    await addManyTrips(source, EXTRA_TRIPS);

    const after = await countStatements(source, search);

    expect(after.result.length).toBeGreaterThanOrEqual(
      before.result.length + EXTRA_TRIPS,
    );
    expect(after.queries).toHaveLength(before.queries.length);
    expect(after.queries).toHaveLength(1);
  });

  it('returns the whole day, with no pagination', async () => {
    const { queries } = await countStatements(source, search);

    // The fare subquery needs LIMIT 1; the outer day query must not paginate.
    // Its ORDER BY is last, so inspect that tail for LIMIT/OFFSET without
    // mistaking the fare limit for pagination.
    const outerTail = queries[0].slice(queries[0].lastIndexOf('ORDER BY'));

    expect(outerTail).not.toMatch(/\bLIMIT\b/i);
    expect(outerTail).not.toMatch(/\bOFFSET\b/i);
    expect(queries[0].match(/\bLIMIT\b/gi)).toHaveLength(1);
  });

  it('orders the whole set by departure from the passenger origin', async () => {
    const rows = await search();

    const departures = rows.map((row) => row.originDepartureAt.getTime());
    expect(departures).toEqual([...departures].sort((a, b) => a - b));
    expect(rows.length).toBeGreaterThan(EXTRA_TRIPS);
  });

  describe('the probes', () => {
    it('asks once when no train number narrowed the search', async () => {
      const { queries } = await countStatements(source, () =>
        repository.probeRouteServed(
          IDS.stations.aswan,
          IDS.stations.alexandria,
          null,
        ),
      );

      expect(queries).toHaveLength(1);
    });

    it('asks once more only when a train number was named', async () => {
      const { queries } = await countStatements(source, () =>
        repository.probeRouteServed(
          IDS.stations.alexandria,
          IDS.stations.ramsis,
          903,
        ),
      );

      expect(queries).toHaveLength(2);
    });

    it('does not ask about the train when the route is not served at all', async () => {
      const { queries } = await countStatements(source, () =>
        repository.probeRouteServed(
          IDS.stations.aswan,
          IDS.stations.alexandria,
          903,
        ),
      );

      expect(queries).toHaveLength(1);
    });
  });

  /**
   * Filter and sort the day in memory. Moving filters into SQL would add
   * queries and multiply cache keys.
   */
  describe('filters and sorts cost nothing extra', () => {
    const everyFilter = {
      trainTypeIds: [IDS.trainTypes.express],
      departAfterMinutes: 5 * 60,
      departBeforeMinutes: 23 * 60,
      maxFareMinor: 50_000,
      excludeSoldOut: true,
    };

    it('narrows a day in memory, with no statement of its own', async () => {
      const { result, queries } = await countStatements(source, search);

      const seats = new Map(
        result.map((row) => [row.tripId, row.classCapacity]),
      );
      const eligible = result.map((row) => ({
        ...row,
        originDepartureMillis: row.originDepartureAt.getTime(),
        destinationArrivalMillis: row.destinationArrivalAt.getTime(),
        durationMinutes: 0,
      }));

      const narrowed = buildTripList({
        eligible: eligible as never,
        seats,
        travelClassId: IDS.travelClasses.first,
        filters: everyFilter,
        sort: 'SEARCH_SORT_FARE_ASC',
      });

      expect(queries).toHaveLength(1);
      expect(narrowed.trips.length).toBeGreaterThan(0);
      const fares = narrowed.trips.map((trip) => trip.fare.amountMinor);
      expect(fares).toEqual([...fares].sort((a, b) => a - b));
    });

    it('reads the same cache key whatever the filters are', () => {
      const key = (trainNumber: number | null) =>
        searchCacheKey({
          originStationId: IDS.stations.alexandria,
          destinationStationId: IDS.stations.ramsis,
          serviceDate: '2026-06-20',
          travelClassId: IDS.travelClasses.first,
          trainNumber,
        });

      // Filters are not cache-key inputs.
      expect(key(null)).toBe(key(null));
      expect(key(null)).not.toBe(key(903));
    });
  });

  /** A cache miss costs one segment read plus one return-day query. */
  describe('the return leg', () => {
    it('costs one segment read plus one day query', async () => {
      const { queries } = await countStatements(source, async () => {
        const segment = await repository.findPassengerSegment(
          IDS.trips.mainLine,
          IDS.stations.alexandria,
          IDS.stations.ramsis,
        );

        // The exact reverse, on the return date.
        return repository.findCandidates({
          originStationId: segment!.destinationStationId,
          destinationStationId: segment!.originStationId,
          travelClassId: IDS.travelClasses.first,
          serviceDate: '2026-06-21',
          trainNumber: null,
          now: NOW,
        });
      });

      expect(queries).toHaveLength(2);
    });

    it('does not grow with the number of return candidates', async () => {
      const reverse = () =>
        repository.findCandidates({
          originStationId: IDS.stations.alexandria,
          destinationStationId: IDS.stations.ramsis,
          travelClassId: IDS.travelClasses.first,
          serviceDate: '2026-06-20',
          trainNumber: null,
          now: NOW,
        });

      const { result, queries } = await countStatements(source, reverse);

      // The earlier growth test leaves its load trips in place.
      expect(result.length).toBeGreaterThan(EXTRA_TRIPS);
      expect(queries).toHaveLength(1);
    });
  });

  it('costs at most three statements for the worst case, an empty narrowed search', async () => {
    const { queries } = await countStatements(source, async () => {
      await repository.findCandidates({
        originStationId: IDS.stations.alexandria,
        destinationStationId: IDS.stations.ramsis,
        travelClassId: IDS.travelClasses.first,
        serviceDate: '2026-07-01',
        trainNumber: 903,
        now: NOW,
      });
      return repository.probeRouteServed(
        IDS.stations.alexandria,
        IDS.stations.ramsis,
        903,
      );
    });

    expect(queries.length).toBeLessThanOrEqual(3);
  });
});
