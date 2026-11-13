import { SEARCH_FIXTURE_IDS as IDS } from '../../apps/catalog/src/database/seeds/search-fixture.js';
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
 * Real Postgres checks the trip join column and three correlated endpoint
 * lookups, including the earliest loop pairing. Stop counts must agree with
 * findCandidates rather than a hardcoded fixture count.
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
      // 06:00 Cairo is 03:00Z in summer; the first stop has no arrival.
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

      // Ramsis still departs at 08:50 Cairo; report the timetable, not just the journey.
      const alighting = rows[rows.length - 1];
      expect(alighting.arrivalAt?.toISOString()).toBe(
        '2026-06-20T05:40:00.000Z',
      );
      expect(alighting.departureAt?.toISOString()).toBe(
        '2026-06-20T05:50:00.000Z',
      );
    });
  });

  /** Compare against findCandidates so search and stop queries cannot drift. */
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
      // Banha is at positions 2 and 4; choose the first arrival after Ramsis.
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

    // Do not expose draft itineraries or journeys that have been withdrawn.
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
