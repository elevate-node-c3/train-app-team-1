import { describe, expect, it, vi } from 'vitest';

import { RecentSearchesService } from './recent-searches.service.js';
import type {
  RecentSearchInput,
  RecentSearchRow,
} from './recent-searches.types.js';

/** 12:00 Cairo on 15 June. */
const NOW = new Date('2026-06-15T09:00:00Z');

const RAMSIS = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';
const TRAVELLER = '44444444-4444-4444-8444-444444444444';

function row(overrides: Partial<RecentSearchRow> = {}): RecentSearchRow {
  return {
    originStationId: RAMSIS,
    originNameEn: 'Ramsis Station',
    originNameAr: 'محطة رمسيس',
    destinationStationId: ALEX,
    destinationNameEn: 'El Raml Station',
    destinationNameAr: 'محطة الرمل',
    travelClassId: FIRST,
    travelClassNameEn: 'First Class',
    travelClassNameAr: 'الدرجة الأولى',
    kind: 'one_way',
    trainNumber: null,
    departureDate: '2026-06-20',
    returnDate: null,
    searchedAt: new Date('2026-06-15T08:00:00Z'),
    ...overrides,
  };
}

const search = (
  overrides: Partial<RecentSearchInput> = {},
): RecentSearchInput => ({
  accountId: TRAVELLER,
  originStationId: RAMSIS,
  destinationStationId: ALEX,
  travelClassId: FIRST,
  kind: 'one_way',
  trainNumber: null,
  departureDate: '2026-06-20',
  returnDate: null,
  ...overrides,
});

function makeService(rows: RecentSearchRow[] = [row()]) {
  const repository = {
    list: vi.fn().mockResolvedValue(rows),
    record: vi.fn().mockResolvedValue(undefined),
  };

  return {
    service: new RecentSearchesService(repository as never),
    repository,
  };
}

describe('the recent-searches service', () => {
  describe('listing', () => {
    it('asks only for the traveller it was given', async () => {
      const { service, repository } = makeService();

      await service.list(TRAVELLER, NOW);

      expect(repository.list).toHaveBeenCalledWith(TRAVELLER);
    });

    it('carries everything a client needs to run the search again', async () => {
      const { service } = makeService([
        row({ kind: 'round_trip', returnDate: '2026-06-25', trainNumber: 903 }),
      ]);

      const { recentSearches } = await service.list(TRAVELLER, NOW);

      expect(recentSearches[0]).toMatchObject({
        origin: { id: RAMSIS },
        destination: { id: ALEX },
        travelClass: { id: FIRST },
        kind: 'RECENT_SEARCH_KIND_ROUND_TRIP',
        trainNumber: 903,
        departureDate: '2026-06-20',
        returnDate: '2026-06-25',
      });
    });

    // Send both languages; the edge chooses.
    it('returns both languages of every name', async () => {
      const { service } = makeService();

      const [entry] = (await service.list(TRAVELLER, NOW)).recentSearches;

      expect(entry.origin.name).toEqual({
        en: 'Ramsis Station',
        ar: 'محطة رمسيس',
      });
      expect(entry.travelClass.name.ar).toBe('الدرجة الأولى');
    });

    it('omits an absent train number rather than sending a zero', async () => {
      const { service } = makeService([row({ trainNumber: null })]);

      const [entry] = (await service.list(TRAVELLER, NOW)).recentSearches;

      // Zero is a train number as far as the wire is concerned.
      expect(entry).not.toHaveProperty('trainNumber');
    });

    it('reports when it was last searched, as a Cairo wall clock', async () => {
      const { service } = makeService();

      const [entry] = (await service.list(TRAVELLER, NOW)).recentSearches;

      expect(entry.searchedAt.localTime).toBe('11:00');
      expect(entry.searchedAt.timeZone).toBe('Africa/Cairo');
    });

    /** Omit stale dates so the client asks for new ones. */
    describe('a stale entry', () => {
      it('comes back without its dates', async () => {
        const { service } = makeService([row({ departureDate: '2026-06-01' })]);

        const [entry] = (await service.list(TRAVELLER, NOW)).recentSearches;

        expect(entry).not.toHaveProperty('departureDate');
        // Keep route, class, and kind so the journey is repeatable with a new date.
        expect(entry.origin.id).toBe(RAMSIS);
        expect(entry.kind).toBe('RECENT_SEARCH_KIND_ONE_WAY');
      });

      it('withholds both dates together, never half a pair', async () => {
        const { service } = makeService([
          row({
            kind: 'round_trip',
            departureDate: '2026-06-01',
            returnDate: '2026-06-05',
          }),
        ]);

        const [entry] = (await service.list(TRAVELLER, NOW)).recentSearches;

        expect(entry).not.toHaveProperty('departureDate');
        expect(entry).not.toHaveProperty('returnDate');
      });

      it('keeps today, which is still bookable', async () => {
        const { service } = makeService([row({ departureDate: '2026-06-15' })]);

        const [entry] = (await service.list(TRAVELLER, NOW)).recentSearches;

        expect(entry.departureDate).toBe('2026-06-15');
      });
    });
  });

  describe('recording', () => {
    it('passes the search and the instant through', async () => {
      const { service, repository } = makeService();

      await service.record(search(), NOW);

      expect(repository.record).toHaveBeenCalledWith(search(), NOW);
    });

    /** Recording failures must not turn successful search responses into errors. */
    it('swallows a failure rather than propagating it', async () => {
      const { service, repository } = makeService();
      repository.record.mockRejectedValue(new Error('deadlock detected'));

      await expect(service.record(search(), NOW)).resolves.toBeUndefined();
    });
  });
});
