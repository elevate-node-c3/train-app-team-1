import {
  SEARCH_FIXTURE_IDS as IDS,
} from '../../apps/catalog/src/database/seeds/search-fixture.js';
import { seedSearchFixture } from '../../apps/catalog/src/database/seeds/search-fixture.seed.js';
import { TripSearchRepository } from '../../apps/catalog/src/modules/trips/trip-search.repository.js';
import { TripStopsRepository } from '../../apps/catalog/src/modules/trips/trip-stops.repository.js';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
  countStatements,
} from './support/catalog-database.js';

/**
 * The stops query, against real Postgres and the real fixture.
 *
 * Three correlated subqueries pin the segment's two ends, and nothing about
 * them can be checked with a mocked query builder: whether `s.trip = :tripId`
 * resolves to the join column, whether the endpoint lookups agree with the
 * pairing `findCandidates` chose, and whether a loop route picks the earliest
 * pairing rather than the widest one.
 *
 * The count rule is the one the story states outright -- "the number of stops
 * between always equals the search result's N Stops count" -- so it is asserted
 * against the search query itself rather than against a number written here.
 */

/** 12:00 Cairo on 15 June: inside the window, before every fixture trip. */
const NOW = new Date('2026-06-15T09:00:00Z');

describe('the trip stops query', () => {
  let source: DataSource;
  let stops: TripStopsRepository;
  let search: TripSearchRepository;

  beforeAll(async () => {
    source = await catalogDataSource();
    await seedSearchFixture(source);
    stops = new TripStopsRepository(source);
    search = new TripSearchRepository(source);
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  describe('the passenger segment', () => {
    it('returns boarding, every stop between, and alighting in travel order', async () => {
      const rows = await stops.findStops({
        tripId: IDS.trips.mainLine,
        originStationId: IDS.stations.alexandria,
        destinationStationId: IDS.stations.ramsis,
      });

      expect(rows.map((row) => row.stationId)).toEqual([
        IDS.stations.alexandria,
        IDS.stations.tanta,
        IDS.stations.banha,
        IDS.stations.ramsis,
      ]);
    });

    it('excludes the stops beyond the passenger destination', async () => {
      const rows = await stops.findStops({
        tripId: IDS.trips.mainLine,
        originStationId: IDS.stations.alexandria,
        destinationStationId: IDS.stations.ramsis,
      });

      // The train continues to Giza, Assiut and Aswan; this traveller does not.
      expect(rows.map((row) => row.stationId)).not.toContain(
        IDS.stations.aswan,
      );
    });

    it('starts mid-route when the passenger boards mid-route', async () => {
      const rows = await stops.findStops({
        tripId: IDS.trips.mainLine,
        originStationId: IDS.stations.tanta,
        destinationStationId: IDS.stations.giza,
      });

      expect(rows.map((row) => row.stationId)).toEqual([
        IDS.stations.tanta,
        IDS.stations.banha,
        IDS.stations.ramsis,
        IDS.stations.giza,
      ]);
    });

    it('carries both names and the stored instants', async () => {
      const rows = await stops.findStops({
        tripId: IDS.trips.mainLine,
        originStationId: IDS.stations.alexandria,
        destinationStationId: IDS.stations.ramsis,
      });

      const [boarding] = rows;
      expect(boarding.stationNameEn.length).toBeGreaterThan(0);
      expect(boarding.stationNameAr.length).toBeGreaterThan(0);
      // 06:00 Cairo in summer, which is 03:00Z. Nothing arrives at a trip's
      // first stop.
      expect(boarding.arrivalAt).toBeNull();
      expect(boarding.departureAt?.toISOString()).toBe(
        '2026-06-20T03:00:00.000Z',
      );
    });

    it('keeps the onward departure of a mid-route alighting stop', async () => {
      const rows = await stops.findStops({
        tripId: IDS.trips.mainLine,
        originStationId: IDS.stations.alexandria,
        destinationStationId: IDS.stations.ramsis,
      });

      // Ramsis is where this traveller gets off, and also a stop the train
      // leaves at 08:50 Cairo. The row reports the timetable, not the journey.
      const alighting = rows[rows.length - 1];
      expect(alighting.arrivalAt?.toISOString()).toBe(
        '2026-06-20T05:40:00.000Z',
      );
      expect(alighting.departureAt?.toISOString()).toBe(
        '2026-06-20T05:50:00.000Z',
      );
    });
  });

  /**
   * The rule the design's "4 Stops" chip depends on. Asserted against
   * `findCandidates` rather than a literal, so the two queries cannot drift
   * apart without this failing.
   */
  describe('the count agrees with the search result (BR-17)', () => {
    it.each([
      ['Alexandria -> Ramsis', IDS.stations.alexandria, IDS.stations.ramsis],
      ['Tanta -> Giza', IDS.stations.tanta, IDS.stations.giza],
      ['Alexandria -> Aswan', IDS.stations.alexandria, IDS.stations.aswan],
    ])('matches intermediateStops for %s', async (_label, from, to) => {
      const candidates = await search.findCandidates({
        originStationId: from,
        destinationStationId: to,
        travelClassId: IDS.travelClasses.first,
        serviceDate: '2026-06-20',
        trainNumber: null,
        now: NOW,
      });

      const result = candidates.find(
        (row) => row.tripId === IDS.trips.mainLine,
      );
      expect(result).toBeDefined();

      const rows = await stops.findStops({
        tripId: IDS.trips.mainLine,
        originStationId: from,
        destinationStationId: to,
      });

      // Both endpoints excluded: that is what "stops between" means.
      expect(rows.length - 2).toBe(result!.intermediateStops);
    });
  });

  describe('a route that calls at a station twice', () => {
    it('takes the earliest valid pairing, as search does', async () => {
      // The loop calls at Banha at position 2 and again at position 4. A
      // traveller boarding at Ramsis alights at the first one.
      const rows = await stops.findStops({
        tripId: IDS.trips.loop,
        originStationId: IDS.stations.ramsis,
        destinationStationId: IDS.stations.banha,
      });

      expect(rows.map((row) => row.stationId)).toEqual([
        IDS.stations.ramsis,
        IDS.stations.banha,
      ]);
      expect(rows[1].arrivalAt?.toISOString()).toBe(
        '2026-06-20T04:50:00.000Z', // 07:50 Cairo, not the 09:30 second call
      );
    });
  });

  describe('what it refuses to describe', () => {
    it('returns nothing for the pair in reverse', async () => {
      const rows = await stops.findStops({
        tripId: IDS.trips.mainLine,
        originStationId: IDS.stations.ramsis,
        destinationStationId: IDS.stations.alexandria,
      });

      expect(rows).toEqual([]);
    });

    it('returns nothing for a station the trip does not call at', async () => {
      const rows = await stops.findStops({
        tripId: IDS.trips.loop,
        originStationId: IDS.stations.ramsis,
        destinationStationId: IDS.stations.aswan,
      });

      expect(rows).toEqual([]);
    });

    // The itinerary of an unpublished trip is data nobody was meant to see,
    // and a withdrawn trip describes a journey nobody can take.
    it.each([
      ['a draft trip', IDS.trips.draft],
      ['a withdrawn trip', IDS.trips.withdrawn],
    ])('returns nothing for %s', async (_label, tripId) => {
      const rows = await stops.findStops({
        tripId,
        originStationId: IDS.stations.alexandria,
        destinationStationId: IDS.stations.ramsis,
      });

      expect(rows).toEqual([]);
    });
  });

  describe('cost', () => {
    it('reads a segment in one statement', async () => {
      const { queries } = await countStatements(source, () =>
        stops.findStops({
          tripId: IDS.trips.mainLine,
          originStationId: IDS.stations.alexandria,
          destinationStationId: IDS.stations.aswan,
        }),
      );

      expect(queries).toHaveLength(1);
    });
  });
});
