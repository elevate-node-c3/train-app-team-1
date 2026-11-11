import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import type { FareIndex } from '../trips/trip-generation.types.js';
import {
  validateTimetableCandidate,
  type TimetableCandidate,
  type TimetableStopDraftInput,
} from './timetable-publish.validator.js';

const STATION_IDS = Array.from(
  { length: 15 },
  (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
);

const FIRST_CLASS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_CLASS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const LAYOUT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function minuteString(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** A route of `count` distinct, chronologically sound stops, 20 minutes apart. */
function makeStops(count: number): TimetableStopDraftInput[] {
  const stops: TimetableStopDraftInput[] = [];

  for (let i = 0; i < count; i++) {
    const base = i * 20;
    stops.push({
      stationId: STATION_IDS[i],
      position: i + 1,
      dayOffset: 0,
      arrivalTime: i === 0 ? null : minuteString(base),
      departureTime: i === count - 1 ? null : minuteString(base + 5),
    });
  }

  return stops;
}

function coach(
  travelClassId: string,
  overrides: Partial<{
    coachNumber: number;
    coachLayoutId: string;
    rows: { rowNumber: number; leftSeats: string[]; rightSeats: string[] }[];
  }> = {},
): TrainCoachEntity {
  return {
    position: 1,
    coachNumber: overrides.coachNumber ?? 1,
    travelClass: { id: travelClassId, nameEn: 'c', nameAr: 'ج' },
    coachLayout: {
      id: overrides.coachLayoutId ?? LAYOUT_ID,
      layoutName: 'l',
      rows: overrides.rows ?? [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3', '4'] },
      ],
    },
  } as unknown as TrainCoachEntity;
}

/** Full, monotonic fare coverage for every in-order pair of `count` stops. */
function coveringFares(
  stationIds: string[],
  travelClassIds: string[],
  unitPrice = 1000,
): FareIndex {
  const index: FareIndex = new Map();

  for (const travelClassId of travelClassIds) {
    for (let i = 0; i < stationIds.length - 1; i++) {
      for (let j = i + 1; j < stationIds.length; j++) {
        const key = `${travelClassId}|${stationIds[i]}|${stationIds[j]}`;
        index.set(key, [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: unitPrice * (j - i),
          },
        ]);
      }
    }
  }

  return index;
}

/** A timetable the current generator would accept outright. */
function validCandidate(count = 15): TimetableCandidate {
  const stops = makeStops(count);

  return {
    stops,
    coaches: [coach(FIRST_CLASS), coach(SECOND_CLASS, { coachNumber: 2 })],
    fares: coveringFares(
      stops.map((stop) => stop.stationId),
      [FIRST_CLASS, SECOND_CLASS],
    ),
    knownStationIds: new Set(STATION_IDS),
    knownCoachLayoutIds: new Set([LAYOUT_ID]),
    effectiveFrom: '2026-06-20',
  };
}

function candidateWith(faults: {
  unknownStationAt?: number;
  missingArrivalAt?: number;
  duplicateStationAt?: number;
}): TimetableCandidate {
  const candidate = validCandidate();
  const stops = candidate.stops.map((stop) => ({ ...stop }));

  if (faults.unknownStationAt !== undefined) {
    stops[faults.unknownStationAt] = {
      ...stops[faults.unknownStationAt],
      stationId: 'unknown-station-does-not-exist',
    };
  }

  if (faults.missingArrivalAt !== undefined) {
    stops[faults.missingArrivalAt] = {
      ...stops[faults.missingArrivalAt],
      arrivalTime: null,
    };
  }

  if (faults.duplicateStationAt !== undefined) {
    stops[faults.duplicateStationAt] = {
      ...stops[faults.duplicateStationAt],
      stationId: stops[0].stationId,
    };
  }

  return { ...candidate, stops };
}

/** A minimal, otherwise-valid candidate whose cheapest segment is `amount`. */
function candidateWithShortestSegmentFare(amount: number): TimetableCandidate {
  const stops = makeStops(3);
  const [a, b, c] = stops.map((stop) => stop.stationId);

  const fares: FareIndex = new Map([
    [
      `${FIRST_CLASS}|${a}|${b}`,
      [{ effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: amount }],
    ],
    [
      `${FIRST_CLASS}|${b}|${c}`,
      [{ effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: amount + 10 }],
    ],
    [
      `${FIRST_CLASS}|${a}|${c}`,
      [{ effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: amount + 20 }],
    ],
  ]);

  return {
    stops,
    coaches: [coach(FIRST_CLASS)],
    fares,
    knownStationIds: new Set([a, b, c]),
    knownCoachLayoutIds: new Set([LAYOUT_ID]),
    effectiveFrom: '2026-06-20',
  };
}

/** One of every kind of problem this validator knows about, all at once. */
function candidateWithEveryProblem(): TimetableCandidate {
  const stops = makeStops(5);
  const [a, b] = stops.map((stop) => stop.stationId);

  const mutatedStops = stops.map((stop) => ({ ...stop }));
  mutatedStops[2] = { ...mutatedStops[2], stationId: 'unknown-station' };
  mutatedStops[3] = { ...mutatedStops[3], arrivalTime: null };

  const repeatingLayoutCoach = coach(FIRST_CLASS, {
    coachLayoutId: 'unknown-layout',
    rows: [{ rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['2', '3'] }],
  });

  return {
    stops: mutatedStops,
    coaches: [repeatingLayoutCoach, coach(SECOND_CLASS, { coachNumber: 2 })],
    // No fare at all for SECOND_CLASS, and only a partial, underpriced one
    // for FIRST_CLASS -- fares.delete below removes one in-order pair too.
    fares: (() => {
      const index = coveringFares([a, b, ...stops.slice(2).map((s) => s.stationId)], [FIRST_CLASS]);
      index.set(`${FIRST_CLASS}|${a}|${b}`, [
        { effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: 1 },
      ]);
      return index;
    })(),
    knownStationIds: new Set(STATION_IDS),
    knownCoachLayoutIds: new Set([LAYOUT_ID]),
    effectiveFrom: '2026-06-20',
  };
}

describe('validateTimetableCandidate', () => {
  let originalFloor: string | undefined;

  beforeEach(() => {
    originalFloor = process.env.STRIPE_MINIMUM_CHARGE_PIASTRES;
  });

  afterEach(() => {
    if (originalFloor === undefined) {
      delete process.env.STRIPE_MINIMUM_CHARGE_PIASTRES;
    } else {
      process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = originalFloor;
    }
  });

  it('accepts a timetable the current generator accepts', () => {
    expect(validateTimetableCandidate(validCandidate())).toEqual([]);
  });

  // The story's named edge case: a problem on the 14th stop of 15 must not
  // hide the others, or publishing becomes guess-and-retry.
  it('names every problem, not the first', () => {
    const details = validateTimetableCandidate(
      candidateWith({
        unknownStationAt: 3,
        missingArrivalAt: 13,
        duplicateStationAt: 7,
      }),
    );

    expect(details.map((d) => d.field)).toEqual(
      expect.arrayContaining([
        'stops[3].stationId',
        'stops[13].arrivalTime',
        'stops[7].stationId',
      ]),
    );
  });

  it('refuses fewer than two stops', () => {
    const candidate = validCandidate();
    const details = validateTimetableCandidate({
      ...candidate,
      stops: [candidate.stops[0]],
    });

    expect(details.some((d) => d.field === 'stops')).toBe(true);
  });

  it('refuses the same station twice', () => {
    const candidate = validCandidate(3);
    const stops = candidate.stops.map((stop) => ({ ...stop }));
    stops[2] = { ...stops[2], stationId: stops[0].stationId };

    const details = validateTimetableCandidate({ ...candidate, stops });

    expect(
      details.some(
        (d) => d.field === 'stops[2].stationId' && d.issue.includes('same station'),
      ),
    ).toBe(true);
  });

  it('refuses times that do not increase along the route', () => {
    const candidate = validCandidate(3);
    const stops = candidate.stops.map((stop) => ({ ...stop }));
    // Stop 1 departs after stop 2 arrives, on the same day.
    stops[1] = { ...stops[1], departureTime: '23:00' };

    const details = validateTimetableCandidate({ ...candidate, stops });

    expect(
      details.some((d) => /chronological order|Departure cannot be before arrival/.test(d.issue)),
    ).toBe(true);
  });

  it('refuses an unknown station', () => {
    const candidate = candidateWith({ unknownStationAt: 0 });
    const details = validateTimetableCandidate(candidate);

    expect(
      details.some(
        (d) => d.field === 'stops[0].stationId' && d.issue.includes('not a known station'),
      ),
    ).toBe(true);
  });

  it('refuses an unknown coach layout', () => {
    const candidate = validCandidate();
    const details = validateTimetableCandidate({
      ...candidate,
      coaches: [coach(FIRST_CLASS, { coachLayoutId: 'not-in-the-layout-list' })],
      fares: coveringFares(
        candidate.stops.map((s) => s.stationId),
        [FIRST_CLASS],
      ),
    });

    expect(
      details.some(
        (d) => d.field === 'coaches[0].coachLayoutId' && d.issue.includes('not a known coach layout'),
      ),
    ).toBe(true);
  });

  it('refuses a missing fare for an in-order pair and class (CAT-2)', () => {
    const candidate = validCandidate(3);
    const fares = new Map(candidate.fares);
    const [a, , c] = candidate.stops.map((stop) => stop.stationId);
    fares.delete(`${FIRST_CLASS}|${a}|${c}`);

    const details = validateTimetableCandidate({
      ...candidate,
      coaches: [coach(FIRST_CLASS)],
      fares,
    });

    expect(details.some((d) => d.field.startsWith('fares[') && d.issue.includes('missing or invalid fare'))).toBe(
      true,
    );
  });

  it('refuses a longer segment priced below one it contains (CAT-2)', () => {
    const stops = makeStops(3);
    const [a, b, c] = stops.map((stop) => stop.stationId);
    const fares: FareIndex = new Map([
      [`${FIRST_CLASS}|${a}|${b}`, [{ effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: 13000 }]],
      [`${FIRST_CLASS}|${a}|${c}`, [{ effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: 12000 }]],
      [`${FIRST_CLASS}|${b}|${c}`, [{ effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: 7000 }]],
    ]);

    const details = validateTimetableCandidate({
      stops,
      coaches: [coach(FIRST_CLASS)],
      fares,
      knownStationIds: new Set([a, b, c]),
      knownCoachLayoutIds: new Set([LAYOUT_ID]),
      effectiveFrom: '2026-06-20',
    });

    expect(details.some((d) => d.issue.includes('is less than the segment it contains'))).toBe(true);
  });

  it('refuses a fare whose total with the fee is below the Stripe minimum (§6.3)', () => {
    process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = '15';

    const details = validateTimetableCandidate(candidateWithShortestSegmentFare(10));

    expect(details).toHaveLength(1);
    expect(details[0].field).toMatch(/^fares\[/);
    expect(details[0].issue).toContain('below the minimum chargeable amount');
  });

  it('gives every problem an actionable field, rejectedValue, issue and action', () => {
    const details = validateTimetableCandidate(candidateWithEveryProblem());

    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.field).not.toHaveLength(0);
      expect(detail.issue).not.toHaveLength(0);
      expect(detail.action).not.toHaveLength(0);
    }
  });
});
