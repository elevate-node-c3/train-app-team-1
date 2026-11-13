import { randomUUID } from 'node:crypto';

import { SEARCH_FIXTURE_IDS as IDS } from '../../apps/catalog/src/database/seeds/search-fixture.js';
import { seedSearchFixture } from '../../apps/catalog/src/database/seeds/search-fixture.seed.js';
import {
  RECENT_SEARCH_LIMIT,
  RecentSearchesRepository,
} from '../../apps/catalog/src/modules/recent-searches/recent-searches.repository.js';
import type { RecentSearchInput } from '../../apps/catalog/src/modules/recent-searches/recent-searches.types.js';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * Real Postgres verifies repeat deduplication, the five-entry cap and
 * active-station joins. Concurrent writes must preserve the cap and uniqueness;
 * a read-then-write implementation can pass single-threaded tests but race here.
 */

const NOW = new Date('2026-06-15T09:00:00Z');

/** Two accounts to check that searches are never shared. */
const TRAVELLER = '77777777-7777-4777-8777-777777777771';
const OTHER_TRAVELLER = '77777777-7777-4777-8777-777777777772';

const search = (
  overrides: Partial<RecentSearchInput> = {},
): RecentSearchInput => ({
  accountId: TRAVELLER,
  originStationId: IDS.stations.ramsis,
  destinationStationId: IDS.stations.alexandria,
  travelClassId: IDS.travelClasses.first,
  kind: 'one_way',
  trainNumber: null,
  departureDate: '2026-06-20',
  returnDate: null,
  ...overrides,
});

/** Five searches with distinct fingerprints. */
function fiveDistinct(): RecentSearchInput[] {
  return [
    search(),
    search({ destinationStationId: IDS.stations.tanta }),
    search({ travelClassId: IDS.travelClasses.second }),
    search({ kind: 'round_trip', returnDate: '2026-06-25' }),
    search({ trainNumber: 903 }),
  ];
}

describe('the recent-searches table', () => {
  let source: DataSource;
  let repository: RecentSearchesRepository;

  beforeAll(async () => {
    source = await catalogDataSource();
    await seedSearchFixture(source);
    repository = new RecentSearchesRepository(source);
  });

  beforeEach(async () => {
    // Keep the fixture network referenced by foreign keys.
    await source.query('DELETE FROM recent_search');
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  const countFor = async (accountId: string): Promise<number> => {
    const [{ count }] = (await source.query(
      'SELECT count(*)::int AS count FROM recent_search WHERE account_id = $1',
      [accountId],
    )) as { count: number }[];
    return count;
  };

  describe('recording a search', () => {
    it('stores it with everything needed to run it again', async () => {
      await repository.record(
        search({ kind: 'round_trip', returnDate: '2026-06-25', trainNumber: 903 }),
        NOW,
      );

      const [entry] = await repository.list(TRAVELLER);

      expect(entry).toMatchObject({
        originStationId: IDS.stations.ramsis,
        destinationStationId: IDS.stations.alexandria,
        travelClassId: IDS.travelClasses.first,
        kind: 'round_trip',
        trainNumber: 903,
        departureDate: '2026-06-20',
        returnDate: '2026-06-25',
      });
      expect(entry.searchedAt).toBeInstanceOf(Date);
    });

    it('joins both languages of every name', async () => {
      await repository.record(search(), NOW);

      const [entry] = await repository.list(TRAVELLER);

      // Catalog returns both languages; the gateway chooses one (BR-56).
      expect(entry.originNameEn.length).toBeGreaterThan(0);
      expect(entry.originNameAr.length).toBeGreaterThan(0);
      expect(entry.travelClassNameEn.length).toBeGreaterThan(0);
      expect(entry.travelClassNameAr.length).toBeGreaterThan(0);
    });

    it('returns a civil date, not an instant', async () => {
      await repository.record(search(), NOW);

      const [entry] = await repository.list(TRAVELLER);

      // Civil dates have no time zone; treating them as instants can shift the day.
      expect(entry.departureDate).toBe('2026-06-20');
    });
  });

  describe('repeating a search', () => {
    it('moves it to the top instead of adding a second entry', async () => {
      await repository.record(search(), NOW);
      await repository.record(search({ destinationStationId: IDS.stations.tanta }), NOW);

      await repository.record(
        search({ departureDate: '2026-07-01' }),
        new Date(NOW.getTime() + 60_000),
      );

      const entries = await repository.list(TRAVELLER);

      expect(entries).toHaveLength(2);
      expect(entries[0].destinationStationId).toBe(IDS.stations.alexandria);
      expect(entries[0].departureDate).toBe('2026-07-01');
    });

    it('treats a round trip on the same route as its own entry', async () => {
      await repository.record(search(), NOW);
      await repository.record(
        search({ kind: 'round_trip', returnDate: '2026-06-25' }),
        NOW,
      );

      expect(await countFor(TRAVELLER)).toBe(2);
    });
  });

  describe('the cap of five', () => {
    it('keeps the newest five and evicts the oldest', async () => {
      const searches = fiveDistinct();
      for (const [index, one] of searches.entries()) {
        await repository.record(one, new Date(NOW.getTime() + index * 1000));
      }

      await repository.record(
        search({ originStationId: IDS.stations.tanta }),
        new Date(NOW.getTime() + 10_000),
      );

      const entries = await repository.list(TRAVELLER);

      expect(entries).toHaveLength(RECENT_SEARCH_LIMIT);
      expect(entries[0].originStationId).toBe(IDS.stations.tanta);
      // Check every fingerprint field; another entry differs only by travel class.
      expect(
        entries.filter(
          (entry) =>
            entry.originStationId === IDS.stations.ramsis &&
            entry.destinationStationId === IDS.stations.alexandria &&
            entry.travelClassId === IDS.travelClasses.first &&
            entry.kind === 'one_way' &&
            entry.trainNumber === null,
        ),
      ).toEqual([]);
    });

    it('returns them newest first', async () => {
      const searches = fiveDistinct();
      for (const [index, one] of searches.entries()) {
        await repository.record(one, new Date(NOW.getTime() + index * 1000));
      }

      const entries = await repository.list(TRAVELLER);
      const times = entries.map((entry) => entry.searchedAt.getTime());

      expect([...times].sort((left, right) => right - left)).toEqual(times);
    });

    /**
     * Submit each of five fingerprints twice at once to expose
     * read-then-write races that create extra or duplicate rows.
     */
    it('holds at five with no duplicate under concurrent writes', async () => {
      const searches = fiveDistinct();

      await Promise.all(
        [...searches, ...searches].map((one) => repository.record(one, NOW)),
      );

      expect(await countFor(TRAVELLER)).toBe(RECENT_SEARCH_LIMIT);

      const [{ count }] = (await source.query(
        `SELECT count(*)::int AS count FROM (
           SELECT fingerprint FROM recent_search WHERE account_id = $1
           GROUP BY fingerprint HAVING count(*) > 1
         ) duplicates`,
        [TRAVELLER],
      )) as { count: number }[];
      expect(count).toBe(0);
    });

    it('holds at five when ten distinct searches arrive at once', async () => {
      const ten = Array.from({ length: 10 }, (_, index) =>
        search({ trainNumber: 900 + index }),
      );

      await Promise.all(ten.map((one) => repository.record(one, NOW)));

      expect(await countFor(TRAVELLER)).toBe(RECENT_SEARCH_LIMIT);
    });
  });

  describe('per traveller, never shared (§2.3 rule 6)', () => {
    it('shows a traveller only their own searches', async () => {
      await repository.record(search(), NOW);
      await repository.record(
        search({ accountId: OTHER_TRAVELLER, trainNumber: 980 }),
        NOW,
      );

      const mine = await repository.list(TRAVELLER);
      const theirs = await repository.list(OTHER_TRAVELLER);

      expect(mine).toHaveLength(1);
      expect(mine[0].trainNumber).toBeNull();
      expect(theirs).toHaveLength(1);
      expect(theirs[0].trainNumber).toBe(980);
    });

    it('caps each traveller independently', async () => {
      for (const [index, one] of fiveDistinct().entries()) {
        await repository.record(one, new Date(NOW.getTime() + index * 1000));
        await repository.record(
          { ...one, accountId: OTHER_TRAVELLER },
          new Date(NOW.getTime() + index * 1000),
        );
      }

      expect(await countFor(TRAVELLER)).toBe(RECENT_SEARCH_LIMIT);
      expect(await countFor(OTHER_TRAVELLER)).toBe(RECENT_SEARCH_LIMIT);
    });

    it('answers an unknown traveller with nothing', async () => {
      await repository.record(search(), NOW);

      expect(await repository.list(randomUUID())).toEqual([]);
    });
  });

  // Do not offer searches whose stations are closed.
  describe('a deactivated station', () => {
    it('drops the entry that references it', async () => {
      await repository.record(search(), NOW);
      await repository.record(
        search({ destinationStationId: IDS.stations.tanta }),
        NOW,
      );

      await source.query(
        'UPDATE station SET is_active = false WHERE id = $1',
        [IDS.stations.tanta],
      );

      try {
        const entries = await repository.list(TRAVELLER);

        expect(entries).toHaveLength(1);
        expect(entries[0].destinationStationId).toBe(
          IDS.stations.alexandria,
        );
        // Hide, do not delete: reactivating the station restores the search.
        expect(await countFor(TRAVELLER)).toBe(2);
      } finally {
        await source.query(
          'UPDATE station SET is_active = true WHERE id = $1',
          [IDS.stations.tanta],
        );
      }
    });
  });
});
