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
} from './support/catalog-database.js';

/**
 * The search query, against real Postgres and the real fixture.
 *
 * This is the statement the whole feature rests on -- the double join that
 * encodes travel order, the Cairo-day range that decides which date a trip
 * belongs to, the capacity lateral that distinguishes "no such coach" from
 * "sold out", and the fare lateral that picks the price in force. None of it
 * can be checked without a database.
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

    // Tanta -> Banha on a southbound train is not a journey: Banha comes
    // first. This is what `d.position > o.position` buys.
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
      // The train left Ramsis at 23:00 on the 19th; Assiut is 04:10 on the
      // 20th, so Assiut onwards belongs to the 20th.
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

    // Not a result at all, as distinct from sold out -- which is capacity
    // above zero with no seats left, and IS returned.
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

    // A missing fare is reported, not hidden: the service decides to drop an
    // unpriceable trip, and a null here is how it finds out.
    it('reports a null fare rather than dropping the row', async () => {
      // Two trips serve Tanta -> Banha in second class: the main line, which
      // calls at both on its way south, and train 404 which runs only that
      // leg. Neither segment is priced, and both must still come back -- the
      // service is what decides an unpriceable trip cannot be sold.
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

  // Review Focus 3: the route calls at Banha twice, so the double join has two
  // valid pairings for one trip. One trip must mean one row.
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

    // Answered from the timetables, not the dated trips, so it stays correct
    // on dates nothing has been generated for.
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
});
