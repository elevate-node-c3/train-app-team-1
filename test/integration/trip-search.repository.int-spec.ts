import {
  SEARCH_FIXTURE_IDS as IDS,
  SEARCH_FIXTURE_TRAIN_NUMBERS as NUMBERS,
} from '../../apps/catalog/src/database/seeds/search-fixture.js';
import { seedSearchFixture } from '../../apps/catalog/src/database/seeds/search-fixture.seed.js';
import { TripSearchRepository } from '../../apps/catalog/src/modules/trips/trip-search.repository.js';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
  countStatements,
} from './support/catalog-database.js';

/**
 * Real Postgres verifies travel-order joins, Cairo-day bounds and the lateral
 * queries for capacity and the fare in force. Distinguish missing coaches from
 * sold-out ones.
 */

/** 12:00 Cairo on 15 June: inside the window, before every fixture trip. */
const NOW = new Date('2026-06-15T09:00:00Z');

/** 10 rows of 2+2 in a first-class coach, 12 rows of 3+3 in second. */
const FIRST_CLASS_SEATS = 40;
const SECOND_CLASS_SEATS = 72;

describe('the trip search query', () => {
  let source: DataSource;
  let repository: TripSearchRepository;

  beforeAll(async () => {
    source = await catalogDataSource();
    await seedSearchFixture(source);
    repository = new TripSearchRepository(source);
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  const search = (params: {
    from: string;
    to: string;
    date: string;
    travelClassId?: string;
    trainNumber?: number | null;
  }) =>
    repository.findCandidates({
      originStationId: params.from,
      destinationStationId: params.to,
      travelClassId: params.travelClassId ?? IDS.travelClasses.first,
      serviceDate: params.date,
      trainNumber: params.trainNumber ?? null,
      now: NOW,
    });

  describe('travel order (BR-15)', () => {
    it('matches any two stops of a route, in travel order', async () => {
      const rows = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-20',
      });

      expect(rows.map((row) => row.tripId)).toContain(IDS.trips.mainLine);
    });

    it('matches a pair in the middle of the route', async () => {
      // Banha -> Giza is a valid search on an Alexandria -> Aswan train.
      const rows = await search({
        from: IDS.stations.banha,
        to: IDS.stations.giza,
        date: '2026-06-20',
      });

      expect(rows.map((row) => row.tripId)).toContain(IDS.trips.mainLine);
    });

    // d.position > o.position excludes reverse journeys.
    it('returns nothing for the same pair in reverse', async () => {
      const rows = await search({
        from: IDS.stations.ramsis,
        to: IDS.stations.alexandria,
        date: '2026-06-20',
      });

      expect(rows).toEqual([]);
    });
  });

  describe('the Cairo date is the one at the passenger origin (BR-16)', () => {
    it('lists an overnight trip under the date it leaves the passenger origin', async () => {
      // Ramsis departs at 23:00 on the 19th; Assiut departs at 04:10 on the 20th.
      // Searches from Assiut therefore use the 20th.
      const onTwentieth = await search({
        from: IDS.stations.assiut,
        to: IDS.stations.aswan,
        date: '2026-06-20',
      });

      expect(onTwentieth.map((row) => row.tripId)).toContain(
        IDS.trips.overnight,
      );
    });

    it('does not list it under the date the train first departed', async () => {
      const onNineteenth = await search({
        from: IDS.stations.assiut,
        to: IDS.stations.aswan,
        date: '2026-06-19',
      });

      expect(onNineteenth.map((row) => row.tripId)).not.toContain(
        IDS.trips.overnight,
      );
    });

    it('still lists the first leg under the earlier date', async () => {
      const rows = await search({
        from: IDS.stations.ramsis,
        to: IDS.stations.assiut,
        date: '2026-06-19',
      });

      expect(rows.map((row) => row.tripId)).toContain(IDS.trips.overnight);
    });
  });

  describe('only what can be sold', () => {
    it('excludes a draft trip', async () => {
      const rows = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-21',
      });

      expect(rows.map((row) => row.tripId)).not.toContain(IDS.trips.draft);
      expect(rows).toEqual([]);
    });

    it('excludes a withdrawn trip', async () => {
      const rows = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-22',
      });

      expect(rows).toEqual([]);
    });
  });

  describe('the requested class', () => {
    it('reports the capacity of that class on the trip', async () => {
      const [first] = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-20',
        travelClassId: IDS.travelClasses.first,
      });
      const second = (
        await search({
          from: IDS.stations.alexandria,
          to: IDS.stations.ramsis,
          date: '2026-06-20',
          travelClassId: IDS.travelClasses.second,
        })
      )[0];

      expect(first.classCapacity).toBe(FIRST_CLASS_SEATS);
      expect(second.classCapacity).toBe(SECOND_CLASS_SEATS);
    });

    // No matching coach is omitted; a matching but sold-out coach is still returned.
    it('omits a train that has no coach of the requested class', async () => {
      const inSecond = await search({
        from: IDS.stations.tanta,
        to: IDS.stations.banha,
        date: '2026-06-20',
        travelClassId: IDS.travelClasses.second,
      });
      const inFirst = await search({
        from: IDS.stations.tanta,
        to: IDS.stations.banha,
        date: '2026-06-20',
        travelClassId: IDS.travelClasses.first,
      });

      expect(inSecond.map((row) => row.tripId)).toContain(
        IDS.trips.singleClass,
      );
      expect(inFirst.map((row) => row.tripId)).not.toContain(
        IDS.trips.singleClass,
      );
    });
  });

  describe('the fare in force', () => {
    it('takes the newest price whose effective_from has arrived', async () => {
      const [row] = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-20',
      });

      // 14000 from January, 15500 from June, 20000 from December.
      expect(row.farePiastres).toBe(15500);
    });

    it('ignores a price that has not started yet', async () => {
      const rows = await repository.findCandidates({
        originStationId: IDS.stations.alexandria,
        destinationStationId: IDS.stations.ramsis,
        travelClassId: IDS.travelClasses.first,
        serviceDate: '2026-06-20',
        trainNumber: null,
        // Before June's price starts, so January's is the one in force.
        now: new Date('2026-03-01T09:00:00Z'),
      });

      expect(rows[0].farePiastres).toBe(14000);
    });

    // The service, not this repository, drops trips with missing fares.
    it('reports a null fare rather than dropping the row', async () => {
      // Main-line and train 404 both serve Tanta -> Banha in second class.
      // Neither segment is priced; return both with null fares.
      const rows = await search({
        from: IDS.stations.tanta,
        to: IDS.stations.banha,
        date: '2026-06-20',
        travelClassId: IDS.travelClasses.second,
      });

      const unpriced = rows.find(
        (row) => row.tripId === IDS.trips.singleClass,
      );

      expect(unpriced).toBeDefined();
      expect(unpriced!.farePiastres).toBeNull();
    });
  });

  describe('the shape of a row', () => {
    it('counts the stops strictly between the two endpoints', async () => {
      const [row] = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-20',
      });

      // Tanta and Banha, excluding Alexandria and Ramsis themselves.
      expect(row.intermediateStops).toBe(2);
    });

    it('carries both endpoints, both names and the train type', async () => {
      const [row] = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-20',
      });

      expect(row.originStationId).toBe(IDS.stations.alexandria);
      expect(row.destinationStationId).toBe(IDS.stations.ramsis);
      expect(row.originNameEn).toBe('Misr Station');
      expect(row.destinationNameAr).toBe('رمسيس');
      expect(row.trainNumber).toBe(NUMBERS.mainLine);
      expect(row.trainTypeEn).toBe('Express');
      expect(row.originDepartureAt).toBeInstanceOf(Date);
      expect(row.destinationArrivalAt).toBeInstanceOf(Date);
    });

    it('reports the instants the trip actually runs at', async () => {
      const [row] = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.ramsis,
        date: '2026-06-20',
      });

      // 06:00 and 08:40 Cairo on 20 June, which is UTC+03:00.
      expect(row.originDepartureAt.toISOString()).toBe(
        '2026-06-20T03:00:00.000Z',
      );
      expect(row.destinationArrivalAt.toISOString()).toBe(
        '2026-06-20T05:40:00.000Z',
      );
    });
  });

  // Two Banha calls create two valid join pairs, but must still produce one trip row.
  describe('a route that calls at the same station twice', () => {
    it('returns one row per trip, taking the earliest pairing', async () => {
      const rows = await search({
        from: IDS.stations.ramsis,
        to: IDS.stations.banha,
        date: '2026-06-20',
      });

      const loopRows = rows.filter((row) => row.tripId === IDS.trips.loop);
      expect(loopRows).toHaveLength(1);
      // Position 1 to position 2, so nothing in between.
      expect(loopRows[0].intermediateStops).toBe(0);
    });
  });

  describe('the optional train number (BR-18)', () => {
    it('narrows the results to that train', async () => {
      const rows = await search({
        from: IDS.stations.ramsis,
        to: IDS.stations.banha,
        date: '2026-06-20',
        trainNumber: NUMBERS.loop,
      });

      expect(rows.map((row) => row.trainNumber)).toEqual([NUMBERS.loop]);
    });

    it('returns nothing for a train that does not serve the pair', async () => {
      const rows = await search({
        from: IDS.stations.ramsis,
        to: IDS.stations.banha,
        date: '2026-06-20',
        trainNumber: NUMBERS.mainLine,
      });

      expect(rows).toEqual([]);
    });
  });

  describe('ordering', () => {
    it('sorts by departure from the passenger origin', async () => {
      const rows = await search({
        from: IDS.stations.alexandria,
        to: IDS.stations.aswan,
        date: '2026-06-20',
      });

      const departures = rows.map((row) => row.originDepartureAt.getTime());
      expect([...departures].sort((a, b) => a - b)).toEqual(departures);
    });
  });

  describe('the empty-reason probes', () => {
    it('finds a served pair', async () => {
      const probe = await repository.probeRouteServed(
        IDS.stations.alexandria,
        IDS.stations.ramsis,
        null,
      );

      expect(probe.routeServed).toBe(true);
    });

    it('reports an unserved direction', async () => {
      const probe = await repository.probeRouteServed(
        IDS.stations.aswan,
        IDS.stations.alexandria,
        null,
      );

      expect(probe.routeServed).toBe(false);
    });

    // Timetable probes work even when no dated trips have been generated.
    it('reports a train that does not serve a pair it was asked about', async () => {
      const probe = await repository.probeRouteServed(
        IDS.stations.ramsis,
        IDS.stations.banha,
        NUMBERS.mainLine,
      );

      expect(probe.routeServed).toBe(true);
      expect(probe.trainServesRoute).toBe(false);
    });

    it('confirms a train that does serve it', async () => {
      const probe = await repository.probeRouteServed(
        IDS.stations.ramsis,
        IDS.stations.banha,
        NUMBERS.loop,
      );

      expect(probe.trainServesRoute).toBe(true);
    });
  });

  /**
   * The server reads the outbound arrival to bound return trips (BR-20).
   * A wrong segment can offer a connection the traveller cannot catch.
   */
  describe('the chosen outbound segment', () => {
    it('reads the departure and arrival of the passenger segment', async () => {
      const segment = await repository.findPassengerSegment(
        IDS.trips.mainLine,
        IDS.stations.alexandria,
        IDS.stations.ramsis,
      );

      // 06:00 and 08:40 Cairo in summer, which are 03:00Z and 05:40Z.
      expect(segment?.originDepartureAt.toISOString()).toBe(
        '2026-06-20T03:00:00.000Z',
      );
      expect(segment?.destinationArrivalAt.toISOString()).toBe(
        '2026-06-20T05:40:00.000Z',
      );
      expect(segment?.originStationId).toBe(IDS.stations.alexandria);
      expect(segment?.destinationStationId).toBe(IDS.stations.ramsis);
    });

    // Use the Cairo departure date for the earliest return date, not the trip's
    // service date or the arrival date.
    it('derives the Cairo departure date from the departure instant', async () => {
      const segment = await repository.findPassengerSegment(
        IDS.trips.overnight,
        IDS.stations.ramsis,
        IDS.stations.aswan,
      );

      // Leaves Ramsis 23:00 on the 19th and lands in Aswan 09:20 on the 20th.
      expect(segment?.cairoDepartureDate).toBe('2026-06-19');
      expect(segment?.destinationArrivalAt.toISOString()).toBe(
        '2026-06-20T06:20:00.000Z',
      );
    });

    it('takes the earliest pairing on a route that calls at a station twice', async () => {
      const segment = await repository.findPassengerSegment(
        IDS.trips.loop,
        IDS.stations.ramsis,
        IDS.stations.banha,
      );

      // 07:50 Cairo, the first call at Banha, not the 09:30 second one.
      expect(segment?.destinationArrivalAt.toISOString()).toBe(
        '2026-06-20T04:50:00.000Z',
      );
    });

    it('returns nothing for the pair in reverse', async () => {
      const segment = await repository.findPassengerSegment(
        IDS.trips.mainLine,
        IDS.stations.ramsis,
        IDS.stations.alexandria,
      );

      expect(segment).toBeNull();
    });

    // Do not derive return bounds from trips that are no longer sellable.
    it.each([
      ['a draft trip', IDS.trips.draft],
      ['a withdrawn trip', IDS.trips.withdrawn],
    ])('returns nothing for %s', async (_label, tripId) => {
      const segment = await repository.findPassengerSegment(
        tripId,
        IDS.stations.alexandria,
        IDS.stations.ramsis,
      );

      expect(segment).toBeNull();
    });

    it('reads the segment in one statement', async () => {
      const { queries } = await countStatements(source, () =>
        repository.findPassengerSegment(
          IDS.trips.mainLine,
          IDS.stations.alexandria,
          IDS.stations.ramsis,
        ),
      );

      expect(queries).toHaveLength(1);
    });
  });
});
