import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingWindowFor } from '@app/contracts';

import {
  TimetableEntity,
  Weekday,
} from '../timetables/entities/timetable.entity.js';
import { TripsService } from './trips.service.js';

/** Noon Cairo on Monday 15 June 2026. Search offers 2026-06-15 .. 2026-07-14. */
const NOON_CAIRO = new Date('2026-06-15T09:00:00.000Z');

function timetable(overrides: Partial<TimetableEntity> = {}): TimetableEntity {
  return {
    id: 'tt-1',
    train: { id: 'train-1' },
    effectiveFrom: '2026-01-01',
    effectiveUntil: null,
    runningDays: [0, 1, 2, 3, 4, 5, 6],
    version: 1,
    status: 'published',
    ...overrides,
  } as TimetableEntity;
}

/**
 * A service whose only live port is the timetable repository. `createDatedTrip`
 * is replaced by a recorder, so these tests see the dates it was asked for.
 */
function makeService(timetables: TimetableEntity[]): {
  service: TripsService;
  dates: string[];
} {
  const service = new TripsService(
    { find: async () => timetables } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const dates: string[] = [];
  service.createDatedTrip = async (_timetable, serviceDate) => {
    dates.push(serviceDate);
    return {} as never;
  };

  return { service, dates };
}

describe('Generation window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_CAIRO);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates every day of the booking window, plus the margin', async () => {
    const { service, dates } = makeService([timetable()]);

    await service.generateUpcomingTrips();

    expect(dates[0]).toBe('2026-06-15');
    expect(dates).toHaveLength(31);
    expect(new Set(dates).size).toBe(31);
  });

  // The coupling that matters: if generation stopped a day earlier, search
  // would offer its last bookable date with no trips on it.
  it('reaches one day past the last date search will offer', async () => {
    const { service, dates } = makeService([timetable()]);

    await service.generateUpcomingTrips();

    const { lastBookableDate } = bookingWindowFor(NOON_CAIRO);
    expect(lastBookableDate).toBe('2026-07-14');
    expect(dates).toContain(lastBookableDate);
    expect(dates.at(-1)).toBe('2026-07-15');
  });

  // "The generation job was down for three days": the window is recomputed from
  // today, so the run after an outage covers the days it missed.
  it('fills the gap after three days down, and still reaches the end', async () => {
    const { service, dates } = makeService([timetable()]);

    await service.generateUpcomingTrips();
    const before = [...dates];
    dates.length = 0;

    vi.setSystemTime(new Date('2026-06-18T09:00:00.000Z'));
    await service.generateUpcomingTrips();

    // The three days the first run would have left at the end.
    for (const missed of ['2026-07-16', '2026-07-17', '2026-07-18']) {
      expect(before).not.toContain(missed);
      expect(dates).toContain(missed);
    }
    expect(dates[0]).toBe('2026-06-18');
  });

  it('asks only for the days a Friday-only timetable runs', async () => {
    const { service, dates } = makeService([
      timetable({ runningDays: [Weekday.Friday] }),
    ]);

    await service.generateUpcomingTrips();

    expect(dates).toContain('2026-06-19');
    expect(dates).not.toContain('2026-06-18');
    expect(dates.every((date) => new Date(date).getUTCDay() === 5)).toBe(true);
  });

  it('refuses a range that ends before it starts', async () => {
    const { service } = makeService([timetable()]);

    await expect(
      service.generateTripsForDateRange('2026-06-20', '2026-06-19'),
    ).rejects.toThrow('Start date cannot be after end date');
  });

  // One broken timetable must not cost every other timetable its window.
  //
  // Two trains, not two timetables of one train: since TA-20 a service date
  // belongs to exactly one of a train's published versions, so two rows of
  // one train would be two versions of the same timetable and only the
  // effective one would generate -- which is a different test. The failure
  // isolation this test is about is between timetables, and that is what
  // separate trains express.
  it('keeps generating other timetables when one fails', async () => {
    const { service, dates } = makeService([
      timetable({ id: 'broken', train: { id: 'train-broken' } as never }),
      timetable({ id: 'healthy', train: { id: 'train-healthy' } as never }),
    ]);

    service.createDatedTrip = async (candidate, serviceDate) => {
      if (candidate.id === 'broken') throw new Error('missing fare');
      dates.push(serviceDate);
      return {} as never;
    };

    await service.generateTripsForDateRange('2026-06-15', '2026-06-16');

    expect(dates).toEqual(['2026-06-15', '2026-06-16']);
  });
});
