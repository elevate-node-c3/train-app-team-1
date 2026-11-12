import { cairoDayBounds } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyFilters,
  filterOptionsFor,
  validateFilters,
  type FilterableTrip,
} from './trip-search-filters.js';

const REGIONAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPRESS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SLEEPER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** 2026-11-10 in Cairo; no DST transition falls on it. */
const DAY_START = cairoDayBounds('2026-11-10').startUtc.getTime();

/** An instant at a Cairo wall-clock minute on the test's day. */
const at = (minutes: number): number => DAY_START + minutes * 60_000;

const trip = (overrides: Partial<FilterableTrip> = {}): FilterableTrip => ({
  tripId: '11111111-1111-4111-8111-111111111111',
  trainTypeId: REGIONAL,
  trainTypeEn: 'Regional',
  trainTypeAr: 'إقليمي',
  originDepartureMillis: at(8 * 60),
  farePiastres: 5_000,
  ...overrides,
});

const fieldsOf = (details: { field: string }[]): string[] =>
  details.map((detail) => detail.field);

describe('validating the search filters', () => {
  it('accepts absent filters and an untouched form', () => {
    expect(validateFilters(undefined)).toEqual([]);
    expect(validateFilters({ trainTypeIds: [] })).toEqual([]);
    expect(
      validateFilters({
        trainTypeIds: [REGIONAL, EXPRESS],
        departAfterMinutes: 6 * 60,
        departBeforeMinutes: 22 * 60,
        maxFareMinor: 12_500,
        excludeSoldOut: true,
      }),
    ).toEqual([]);
  });

  it('names every refusal with a field and an action to take', () => {
    // BR-57: the traveller has to know which filter to change.
    const details = validateFilters({
      trainTypeIds: ['not-a-uuid'],
      departAfterMinutes: -1,
      departBeforeMinutes: 24 * 60,
      maxFareMinor: -5,
      excludeSoldOut: 'yes' as unknown as boolean,
    });

    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.field).not.toBe('');
      expect(detail.issueKey).toMatch(/^ISSUE_/);
      expect(detail.actionKey).toMatch(/^ACTION_/);
      expect(detail).not.toHaveProperty('issue');
      expect(detail).not.toHaveProperty('action');
    }
  });

  it('refuses a train type that is not an identifier', () => {
    const details = validateFilters({ trainTypeIds: [REGIONAL, 'nope'] });

    expect(fieldsOf(details)).toEqual(['trainTypeIds']);
    expect(details[0].rejectedValue).toBe('nope');
  });

  describe('the departure window', () => {
    it('refuses minutes outside one Cairo day', () => {
      expect(fieldsOf(validateFilters({ departAfterMinutes: -1 }))).toEqual([
        'departAfterMinutes',
      ]);
      expect(
        fieldsOf(validateFilters({ departAfterMinutes: 24 * 60 })),
      ).toEqual(['departAfterMinutes']);
      expect(
        fieldsOf(validateFilters({ departBeforeMinutes: 24 * 60 })),
      ).toEqual(['departBeforeMinutes']);
    });

    it('refuses a fraction of a minute', () => {
      expect(fieldsOf(validateFilters({ departAfterMinutes: 8.5 }))).toEqual([
        'departAfterMinutes',
      ]);
    });

    // BR-18 scopes the window to one civil day. Reinterpreting 22:00-02:00 as
    // wrapping would quietly search tomorrow as well.
    it('refuses a window that would wrap past midnight, naming the later bound', () => {
      const details = validateFilters({
        departAfterMinutes: 22 * 60,
        departBeforeMinutes: 2 * 60,
      });

      expect(fieldsOf(details)).toEqual(['departBeforeMinutes']);
      expect(details[0].rejectedValue).toBe(2 * 60);
    });

    it('refuses an empty window', () => {
      expect(
        fieldsOf(
          validateFilters({
            departAfterMinutes: 8 * 60,
            departBeforeMinutes: 8 * 60,
          }),
        ),
      ).toEqual(['departBeforeMinutes']);
    });
  });

  describe('the maximum fare', () => {
    it('accepts zero and a positive whole number of piastres', () => {
      expect(validateFilters({ maxFareMinor: 0 })).toEqual([]);
      expect(validateFilters({ maxFareMinor: 12_500 })).toEqual([]);
    });

    it('refuses a negative or fractional amount', () => {
      expect(fieldsOf(validateFilters({ maxFareMinor: -1 }))).toEqual([
        'maxFareMinor',
      ]);
      expect(fieldsOf(validateFilters({ maxFareMinor: 12.5 }))).toEqual([
        'maxFareMinor',
      ]);
    });
  });

  it('refuses a sold-out choice that is not a boolean', () => {
    expect(
      fieldsOf(
        validateFilters({
          excludeSoldOut: 'true' as unknown as boolean,
        }),
      ),
    ).toEqual(['excludeSoldOut']);
  });
});

describe('applying the search filters', () => {
  it('returns the whole list when no filter is set', () => {
    const trips = [trip({ tripId: '1' }), trip({ tripId: '2' })];

    expect(applyFilters(trips, undefined)).toEqual(trips);
    expect(applyFilters(trips, {})).toEqual(trips);
  });

  it('narrows to the selected train types, preserving the day order', () => {
    const early = trip({ tripId: 'early', trainTypeId: REGIONAL });
    const express = trip({
      tripId: 'express',
      trainTypeId: EXPRESS,
      trainTypeEn: 'Express',
    });
    const late = trip({
      tripId: 'late',
      trainTypeId: REGIONAL,
      originDepartureMillis: at(20 * 60),
    });
    const sleeper = trip({
      tripId: 'sleeper',
      trainTypeId: SLEEPER,
      trainTypeEn: 'Sleeper',
      originDepartureMillis: at(21 * 60),
    });

    expect(
      applyFilters([early, express, late, sleeper], {
        trainTypeIds: [REGIONAL],
      }).map((candidate) => candidate.tripId),
    ).toEqual(['early', 'late']);

    // More than one selected type is a union, not an intersection.
    expect(
      applyFilters([early, express, late, sleeper], {
        trainTypeIds: [REGIONAL, EXPRESS],
      }).map((candidate) => candidate.tripId),
    ).toEqual(['early', 'express', 'late']);

    // An empty selection is "any type", not "no trips".
    expect(
      applyFilters([early, express, late, sleeper], { trainTypeIds: [] }),
    ).toHaveLength(4);
  });

  it('keeps a trip whose Cairo departure is inside the window, endpoints included', () => {
    const before = trip({
      tripId: 'before',
      originDepartureMillis: at(7 * 60 + 59),
    });
    const atStart = trip({
      tripId: 'at-start',
      originDepartureMillis: at(8 * 60),
    });
    const atEnd = trip({
      tripId: 'at-end',
      originDepartureMillis: at(10 * 60),
    });
    const after = trip({
      tripId: 'after',
      originDepartureMillis: at(10 * 60 + 1),
    });

    expect(
      applyFilters([before, atStart, atEnd, after], {
        departAfterMinutes: 8 * 60,
        departBeforeMinutes: 10 * 60,
      }).map((candidate) => candidate.tripId),
    ).toEqual(['at-start', 'at-end']);
  });

  it('reads the window as Cairo wall-clock time, not UTC', () => {
    // 08:00 Cairo is 06:00 UTC in November.
    const morning = trip({ originDepartureMillis: at(8 * 60) });

    expect(
      applyFilters([morning], {
        departAfterMinutes: 7 * 60 + 30,
        departBeforeMinutes: 8 * 60 + 30,
      }),
    ).toHaveLength(1);
    expect(
      applyFilters([morning], {
        departAfterMinutes: 8 * 60 + 30,
        departBeforeMinutes: 9 * 60,
      }),
    ).toEqual([]);
  });

  it('applies either departure bound on its own', () => {
    const early = trip({ tripId: 'early', originDepartureMillis: at(6 * 60) });
    const late = trip({ tripId: 'late', originDepartureMillis: at(18 * 60) });

    expect(
      applyFilters([early, late], { departAfterMinutes: 12 * 60 }).map(
        (candidate) => candidate.tripId,
      ),
    ).toEqual(['late']);
    expect(
      applyFilters([early, late], { departBeforeMinutes: 12 * 60 }).map(
        (candidate) => candidate.tripId,
      ),
    ).toEqual(['early']);
  });

  it('keeps fares up to the ceiling and drops unpriced trips', () => {
    const cheap = trip({ tripId: 'cheap', farePiastres: 3_000 });
    const ceiling = trip({ tripId: 'ceiling', farePiastres: 5_000 });
    const over = trip({ tripId: 'over', farePiastres: 5_001 });
    const unpriced = trip({ tripId: 'unpriced', farePiastres: null });

    expect(
      applyFilters([cheap, ceiling, over, unpriced], {
        maxFareMinor: 5_000,
      }).map((candidate) => candidate.tripId),
    ).toEqual(['cheap', 'ceiling']);
  });

  it('returns an empty list, not an error, when the ceiling is below every fare', () => {
    const trips = [
      trip({ farePiastres: 3_000 }),
      trip({ farePiastres: 5_000 }),
    ];

    // The filter is a valid narrowing that happened to match nothing; the
    // service reports that as FILTERS_EXCLUDED_ALL rather than a refusal.
    expect(applyFilters(trips, { maxFareMinor: 2_999 })).toEqual([]);
    expect(validateFilters({ maxFareMinor: 2_999 })).toEqual([]);
  });

  it('drops sold-out trips only when the traveller asked', () => {
    const available = trip({ tripId: 'available' });
    const soldOut = trip({ tripId: 'sold-out' });
    const soldOutIds = new Set(['sold-out']);

    expect(
      applyFilters([available, soldOut], { excludeSoldOut: false }, soldOutIds),
    ).toEqual([available, soldOut]);
    expect(
      applyFilters(
        [available, soldOut],
        { excludeSoldOut: true },
        soldOutIds,
      ).map((candidate) => candidate.tripId),
    ).toEqual(['available']);
  });

  it('refuses to ignore excludeSoldOut when no sold-out set is supplied', () => {
    // A forgotten argument must not produce a confidently wrong list.
    expect(() => applyFilters([trip()], { excludeSoldOut: true })).toThrow(
      /sold-out set/,
    );
  });
});

describe('computing the day facets', () => {
  it('counts each train type once and orders them by name', () => {
    const trips = [
      trip({ trainTypeId: REGIONAL, trainTypeEn: 'Regional' }),
      trip({
        trainTypeId: SLEEPER,
        trainTypeEn: 'Sleeper',
        trainTypeAr: 'نوم',
      }),
      trip({ trainTypeId: REGIONAL, trainTypeEn: 'Regional' }),
    ];

    expect(filterOptionsFor(trips).trainTypes).toEqual([
      {
        id: REGIONAL,
        name: { en: 'Regional', ar: 'إقليمي' },
        tripCount: 2,
      },
      {
        id: SLEEPER,
        name: { en: 'Sleeper', ar: 'نوم' },
        tripCount: 1,
      },
    ]);
  });

  it('takes the fare range from priced trips only', () => {
    const options = filterOptionsFor([
      trip({ farePiastres: 7_500 }),
      trip({ farePiastres: 2_500 }),
      trip({ farePiastres: null }),
    ]);

    expect(options.minFareMinor).toBe(2_500);
    expect(options.maxFareMinor).toBe(7_500);
  });

  it('reports a neutral range when the day has no priced trip', () => {
    expect(filterOptionsFor([])).toEqual({
      trainTypes: [],
      minFareMinor: 0,
      maxFareMinor: 0,
    });
    expect(filterOptionsFor([trip({ farePiastres: null })])).toMatchObject({
      minFareMinor: 0,
      maxFareMinor: 0,
    });
  });

  it('describes the unfiltered day even when a filter would remove the type', () => {
    const regional = trip({ trainTypeId: REGIONAL, trainTypeEn: 'Regional' });
    const sleeper = trip({
      trainTypeId: SLEEPER,
      trainTypeEn: 'Sleeper',
    });
    const filtered = applyFilters([regional, sleeper], {
      trainTypeIds: [REGIONAL],
    });

    // The facet comes from the whole day, so the UI can still offer Sleeper.
    expect(
      filterOptionsFor([regional, sleeper]).trainTypes.map((type) => type.id),
    ).toContain(SLEEPER);
    expect(filtered.map((candidate) => candidate.tripId)).toHaveLength(1);
  });
});
