import { describe, expect, it } from 'vitest';

import {
  TimetableEntity,
  Weekday,
} from '../timetables/entities/timetable.entity.js';
import { TripsService } from './trips.service.js';

/**
 * One train, two published versions. D is 2026-06-20: v1 took effect at D-10,
 * v2 takes effect at D+2.
 */
const TRAIN = '11111111-1111-4111-8111-111111111111';
const WINDOW_START = '2026-06-20';
const WINDOW_END = '2026-06-25';

function timetable(overrides: Partial<TimetableEntity>): TimetableEntity {
  return {
    id: `tt-v${overrides.version ?? 1}`,
    train: { id: TRAIN },
    runningDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: '2026-06-10',
    effectiveUntil: null,
    version: 1,
    status: 'published',
    ...overrides,
  } as TimetableEntity;
}

/**
 * v1 is left *unbounded* on purpose. That is the shape the generator used to
 * get wrong: two published rows both claiming D+2 onwards, with the
 * (train, service_date) unique constraint ready to swallow the second write as
 * "already exists" instead of surfacing it.
 */
function twoVersions(
  overrides: Partial<TimetableEntity> = {},
): TimetableEntity[] {
  return [
    timetable({ version: 1, effectiveFrom: '2026-06-10' }),
    timetable({ version: 2, effectiveFrom: '2026-06-22', ...overrides }),
  ];
}

interface GeneratedTrip {
  serviceDate: string;
  timetableId: string;
  version: number;
}

function makeService(timetables: TimetableEntity[]): {
  service: TripsService;
  trips: GeneratedTrip[];
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

  const trips: GeneratedTrip[] = [];
  service.createDatedTrip = async (candidate, serviceDate) => {
    trips.push({
      serviceDate,
      timetableId: candidate.id,
      version: candidate.version,
    });
    return {} as never;
  };

  return { service, trips };
}

function tripsOn(trips: GeneratedTrip[], serviceDate: string): GeneratedTrip[] {
  return trips.filter((trip) => trip.serviceDate === serviceDate);
}

function tripOn(trips: GeneratedTrip[], serviceDate: string): GeneratedTrip {
  const matching = tripsOn(trips, serviceDate);
  expect(matching).toHaveLength(1);
  return matching[0];
}

describe('trip generation across versions', () => {
  it('generates each service date once when two versions coexist', async () => {
    const { service, trips } = makeService(twoVersions());

    await service.generateTripsForDateRange(WINDOW_START, WINDOW_END);

    expect(tripsOn(trips, '2026-06-23')).toHaveLength(1);
    // And from the right version. A count alone would pass a generator that
    // returned v1 for every date past the cutover.
    expect(tripOn(trips, '2026-06-23').version).toBe(2);
    // Six civil days, six trips: no date is produced twice, and none is lost.
    expect(trips).toHaveLength(6);
    expect(new Set(trips.map((trip) => trip.serviceDate)).size).toBe(6);
  });

  /**
   * Two rows a `(effective_from, version)` comparison cannot tell apart.
   *
   * This is impossible data -- `uq_timetable_train_version` forbids it -- but
   * the guard must not depend on that to produce one trip per date, or
   * "exactly once" is a property of the constraints rather than of the
   * generator, and `createDatedTrip`'s unique-violation recovery would hide
   * the second write as "already exists".
   */
  it('generates once from two published rows it cannot tell apart by version', async () => {
    const { service, trips } = makeService([
      timetable({ id: 'tt-a', version: 1, effectiveFrom: '2026-06-10' }),
      timetable({ id: 'tt-b', version: 1, effectiveFrom: '2026-06-10' }),
    ]);

    await service.generateTripsForDateRange(WINDOW_START, WINDOW_END);

    expect(trips).toHaveLength(6);
    // One of them, consistently -- never both.
    expect(new Set(trips.map((trip) => trip.timetableId))).toEqual(
      new Set(['tt-a']),
    );
  });

  it('generates a date before the new effective date from the old version', async () => {
    const { service, trips } = makeService(twoVersions());

    await service.generateTripsForDateRange(WINDOW_START, WINDOW_END);

    expect(tripOn(trips, '2026-06-21').version).toBe(1);
    expect(tripOn(trips, '2026-06-21').timetableId).toBe('tt-v1');
  });

  it('generates a date on the new effective date from the new version', async () => {
    const { service, trips } = makeService(twoVersions());

    await service.generateTripsForDateRange(WINDOW_START, WINDOW_END);

    expect(tripOn(trips, '2026-06-22').version).toBe(2);
    expect(tripOn(trips, '2026-06-22').timetableId).toBe('tt-v2');
  });

  // The reason the effective version is resolved from the range alone and not
  // from the running days: once v2 owns a date, a date v2 does not run on has
  // no trip. The superseded version must not quietly fill it in.
  it('leaves a date the new version does not run on empty', async () => {
    const { service, trips } = makeService(
      twoVersions({ runningDays: [Weekday.Friday] }),
    );

    await service.generateTripsForDateRange(WINDOW_START, WINDOW_END);

    // 2026-06-26 is the next Friday, past the window; 2026-06-22..25 are
    // Monday to Thursday, and v1 ran daily.
    expect(tripsOn(trips, '2026-06-23')).toEqual([]);
    expect(trips.map((trip) => trip.serviceDate)).toEqual([
      '2026-06-20',
      '2026-06-21',
    ]);
  });

  // A withdrawn predecessor is not a live version, so the row the publish
  // superseded cannot claim a date back.
  it('generates from the live version when the predecessor was bounded', async () => {
    const { service, trips } = makeService([
      timetable({
        version: 1,
        effectiveFrom: '2026-06-10',
        effectiveUntil: '2026-06-21',
      }),
      timetable({ version: 2, effectiveFrom: '2026-06-22' }),
    ]);

    await service.generateTripsForDateRange(WINDOW_START, WINDOW_END);

    expect(trips).toHaveLength(6);
    expect(tripOn(trips, '2026-06-21').version).toBe(1);
    expect(tripOn(trips, '2026-06-22').version).toBe(2);
  });
});
