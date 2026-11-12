import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import {
  resolveStopTimes,
  type FareIndex,
} from '../trips/trip-generation.types.js';
import {
  validateCapacityIssues,
  validateFareFloor,
  validateFareRules,
  validateNoDuplicateStations,
  validateStopsChronology,
  validateStopsStructure,
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

/** Positive, monotonic fares for every forward pair. */
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

/** Keep other fields valid to isolate the minimum-fare check. */
function candidateWithShortestSegmentFare(amount: number): TimetableCandidate {
  const stops = makeStops(3);
  const [a, b, c] = stops.map((stop) => stop.stationId);

  const fares: FareIndex = new Map([
    [
      `${FIRST_CLASS}|${a}|${b}`,
      [
        {
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          amountPiastres: amount,
        },
      ],
    ],
    [
      `${FIRST_CLASS}|${b}|${c}`,
      [
        {
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          amountPiastres: amount + 10,
        },
      ],
    ],
    [
      `${FIRST_CLASS}|${a}|${c}`,
      [
        {
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          amountPiastres: amount + 20,
        },
      ],
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
    // SECOND_CLASS has no fares; FIRST_CLASS is partial and underpriced.
    fares: (() => {
      const index = coveringFares(
        [a, b, ...stops.slice(2).map((s) => s.stationId)],
        [FIRST_CLASS],
      );
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

  // Return all validation faults together, including late-route faults.
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

  it.each([0, 1])(
    'refuses a %i-stop route with the same key in both route validators',
    (count) => {
      const candidate = validCandidate();
      const details = validateTimetableCandidate({
        ...candidate,
        stops: candidate.stops.slice(0, count),
      });

      const routeIssue = {
        field: 'stops',
        rejectedValue: count,
        issueKey: 'ISSUE_ROUTE_NEEDS_TWO_STOPS',
        actionKey: 'ACTION_ADD_STOPS_TO_TWO',
      };
      expect(details).toEqual([routeIssue, routeIssue]);
    },
  );

  it('refuses the same station twice', () => {
    const candidate = validCandidate(3);
    const stops = candidate.stops.map((stop) => ({ ...stop }));
    stops[2] = { ...stops[2], stationId: stops[0].stationId };

    const details = validateTimetableCandidate({ ...candidate, stops });

    expect(details).toContainEqual({
      field: 'stops[2].stationId',
      rejectedValue: stops[0].stationId,
      issueKey: 'ISSUE_STATION_REPEATED_ON_ROUTE',
      actionKey: 'ACTION_REMOVE_REPEATED_STATION',
      params: { firstStopIndex: '0' },
    });
  });

  it('refuses times that do not increase along the route', () => {
    const candidate = validCandidate(3);
    const stops = candidate.stops.map((stop) => ({ ...stop }));
    // Stop 1 departs after stop 2 arrives, on the same day.
    stops[1] = { ...stops[1], departureTime: '23:00' };

    const details = validateTimetableCandidate({ ...candidate, stops });

    const { arrivalAt } = resolveStopTimes(
      candidate.effectiveFrom,
      stops[2].dayOffset,
      stops[2].arrivalTime,
      stops[2].departureTime,
    );
    expect(details).toContainEqual({
      field: 'stops[2].arrivalTime',
      rejectedValue: arrivalAt!.toISOString(),
      issueKey: 'ISSUE_STOP_TIMES_OUT_OF_ORDER',
      actionKey: 'ACTION_FIX_STOP_TIME_ORDER',
    });
  });

  it('refuses an unknown station', () => {
    const candidate = candidateWith({ unknownStationAt: 0 });
    const details = validateTimetableCandidate(candidate);

    expect(details).toContainEqual({
      field: 'stops[0].stationId',
      rejectedValue: 'unknown-station-does-not-exist',
      issueKey: 'ISSUE_STATION_NOT_KNOWN',
      actionKey: 'ACTION_PICK_STATION_FROM_LIST',
    });
  });

  it('refuses an unknown coach layout', () => {
    const candidate = validCandidate();
    const details = validateTimetableCandidate({
      ...candidate,
      coaches: [
        coach(FIRST_CLASS, { coachLayoutId: 'not-in-the-layout-list' }),
      ],
      fares: coveringFares(
        candidate.stops.map((s) => s.stationId),
        [FIRST_CLASS],
      ),
    });

    expect(details).toContainEqual({
      field: 'coaches[0].coachLayoutId',
      rejectedValue: 'not-in-the-layout-list',
      issueKey: 'ISSUE_COACH_LAYOUT_NOT_KNOWN',
      actionKey: 'ACTION_PICK_COACH_LAYOUT_FROM_LIST',
    });
  });

  it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses a missing or invalid (%s) fare for an in-order pair and class (CAT-2)',
    (amountPiastres) => {
      const candidate = validCandidate(3);
      const fares = new Map(candidate.fares);
      const [a, , c] = candidate.stops.map((stop) => stop.stationId);
      if (amountPiastres === null) {
        fares.delete(`${FIRST_CLASS}|${a}|${c}`);
      } else {
        fares.set(`${FIRST_CLASS}|${a}|${c}`, [
          { effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres },
        ]);
      }

      const details = validateTimetableCandidate({
        ...candidate,
        coaches: [coach(FIRST_CLASS)],
        fares,
      });

      expect(details).toEqual([
        {
          field: `fares[${FIRST_CLASS}:${a}->${c}]`,
          rejectedValue: null,
          issueKey: 'ISSUE_FARE_MISSING_FOR_PAIR',
          actionKey: 'ACTION_ADD_FARE_FOR_PAIR',
          params: {
            travelClassId: FIRST_CLASS,
            originStationId: a,
            destinationStationId: c,
          },
        },
      ]);
    },
  );

  it('refuses a longer segment priced below one it contains (CAT-2)', () => {
    const stops = makeStops(3);
    const [a, b, c] = stops.map((stop) => stop.stationId);
    const fares: FareIndex = new Map([
      [
        `${FIRST_CLASS}|${a}|${b}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 13000,
          },
        ],
      ],
      [
        `${FIRST_CLASS}|${a}|${c}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 12000,
          },
        ],
      ],
      [
        `${FIRST_CLASS}|${b}|${c}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 7000,
          },
        ],
      ],
    ]);

    const details = validateTimetableCandidate({
      stops,
      coaches: [coach(FIRST_CLASS)],
      fares,
      knownStationIds: new Set([a, b, c]),
      knownCoachLayoutIds: new Set([LAYOUT_ID]),
      effectiveFrom: '2026-06-20',
    });

    expect(details).toEqual([
      {
        field: `fares[${FIRST_CLASS}:${a}->${c}]`,
        rejectedValue: 12000,
        issueKey: 'ISSUE_FARE_BELOW_CONTAINED_SEGMENT_FOR_PAIR',
        actionKey: 'ACTION_RAISE_FARE_FOR_PAIR',
        params: {
          travelClassId: FIRST_CLASS,
          outerOriginIndex: '0',
          outerDestinationIndex: '2',
          innerOriginIndex: '0',
          innerDestinationIndex: '1',
          outerFarePiastres: '12000',
          innerFarePiastres: '13000',
        },
      },
    ]);
  });

  it('refuses a fare below the Stripe minimum with the shared payment keys (§6.3)', () => {
    process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = '15';

    const candidate = candidateWithShortestSegmentFare(10);
    const details = validateTimetableCandidate(candidate);
    const [a, b] = candidate.stops.map((stop) => stop.stationId);

    expect(details).toEqual([
      {
        field: `fares[${FIRST_CLASS}:${a}->${b}]`,
        rejectedValue: 10,
        issueKey: 'ISSUE_FARE_BELOW_PAYMENT_MINIMUM',
        actionKey: 'ACTION_RAISE_FARE_TO_PAYMENT_MINIMUM',
      },
    ]);
  });

  it('gives every problem a field, rejectedValue and language-free issue/action keys', () => {
    const details = validateTimetableCandidate(candidateWithEveryProblem());

    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.field).not.toHaveLength(0);
      expect(detail).toHaveProperty('rejectedValue');
      expect(detail.issueKey).toMatch(/^ISSUE_[A-Z0-9_]+$/);
      expect(detail.actionKey).toMatch(/^ACTION_[A-Z0-9_]+$/);
      expect(detail).not.toHaveProperty('issue');
      expect(detail).not.toHaveProperty('action');
      for (const value of Object.values(detail.params ?? {})) {
        expect(value).toEqual(expect.any(String));
      }
    }
  });
});

// Generation must not inherit publish-only duplicate-station or fare-floor checks.
describe('generation safety: duplicate-station and the Stripe floor stay publish-only', () => {
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

  it('validateStopsStructure accepts a repeated-station stop list (an already-published loop route)', () => {
    const stops = makeStops(3);
    stops[2] = { ...stops[2], stationId: stops[0].stationId };

    const details = validateStopsStructure(
      stops,
      new Set(stops.map((s) => s.stationId)),
    );

    expect(details).toEqual([]);
  });

  it('validateNoDuplicateStations refuses the same repeated-station stop list', () => {
    const stops = makeStops(3);
    stops[2] = { ...stops[2], stationId: stops[0].stationId };

    const details = validateNoDuplicateStations(stops);

    expect(details).toEqual([
      {
        field: 'stops[2].stationId',
        rejectedValue: stops[0].stationId,
        issueKey: 'ISSUE_STATION_REPEATED_ON_ROUTE',
        actionKey: 'ACTION_REMOVE_REPEATED_STATION',
        params: { firstStopIndex: '0' },
      },
    ]);
  });

  it('validateFareRules is unaffected by STRIPE_MINIMUM_CHARGE_PIASTRES being set', () => {
    const stops = makeStops(3);
    const resolved = stops.map((stop) => ({
      stationId: stop.stationId,
      ...resolveStopTimes(
        '2026-06-20',
        stop.dayOffset,
        stop.arrivalTime,
        stop.departureTime,
      ),
    }));
    const [a, b, c] = stops.map((s) => s.stationId);

    // Prices pass `validateFareRules`; only the floor check would reject them.
    const fares: FareIndex = new Map([
      [
        `${FIRST_CLASS}|${a}|${b}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 2,
          },
        ],
      ],
      [
        `${FIRST_CLASS}|${b}|${c}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 3,
          },
        ],
      ],
      [
        `${FIRST_CLASS}|${a}|${c}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 5,
          },
        ],
      ],
    ]);

    process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = '1000000';

    const details = validateFareRules([coach(FIRST_CLASS)], resolved, fares);

    expect(details).toEqual([]);
  });

  it('validateFareFloor still refuses the same below-floor fare validateFareRules let through', () => {
    const stops = makeStops(3);
    const resolved = stops.map((stop) => ({
      stationId: stop.stationId,
      ...resolveStopTimes(
        '2026-06-20',
        stop.dayOffset,
        stop.arrivalTime,
        stop.departureTime,
      ),
    }));
    const [a, b, c] = stops.map((s) => s.stationId);

    const fares: FareIndex = new Map([
      [
        `${FIRST_CLASS}|${a}|${b}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 2,
          },
        ],
      ],
      [
        `${FIRST_CLASS}|${b}|${c}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 3,
          },
        ],
      ],
      [
        `${FIRST_CLASS}|${a}|${c}`,
        [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            amountPiastres: 5,
          },
        ],
      ],
    ]);

    process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = '1000000';

    expect(validateFareRules([coach(FIRST_CLASS)], resolved, fares)).toEqual(
      [],
    );
    const floorDetails = validateFareFloor(
      [coach(FIRST_CLASS)],
      resolved,
      fares,
    );
    expect(floorDetails).toEqual([
      {
        field: `fares[${FIRST_CLASS}:${a}->${b}]`,
        rejectedValue: 2,
        issueKey: 'ISSUE_FARE_BELOW_PAYMENT_MINIMUM',
        actionKey: 'ACTION_RAISE_FARE_TO_PAYMENT_MINIMUM',
      },
    ]);
  });

  it('validateTimetableCandidate still refuses both a repeated station and a below-floor fare', () => {
    process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = '1000000';

    const candidate = validCandidate(3);
    const stops = candidate.stops.map((stop) => ({ ...stop }));
    stops[2] = { ...stops[2], stationId: stops[0].stationId };

    const details = validateTimetableCandidate({ ...candidate, stops });

    expect(details.map((d) => d.issueKey)).toEqual(
      expect.arrayContaining([
        'ISSUE_STATION_REPEATED_ON_ROUTE',
        'ISSUE_FARE_BELOW_PAYMENT_MINIMUM',
      ]),
    );
  });
});

describe('validateStopsStructure refs', () => {
  it('keeps the four endpoint rules and their rejected values distinct', () => {
    const stops = makeStops(3);
    stops[0] = { ...stops[0], arrivalTime: '00:00', departureTime: null };
    stops[2] = { ...stops[2], arrivalTime: null, departureTime: '00:45' };

    expect(validateStopsStructure(stops, new Set(STATION_IDS))).toEqual([
      {
        field: 'stops[0].arrivalTime',
        rejectedValue: '00:00',
        issueKey: 'ISSUE_FIRST_STOP_HAS_ARRIVAL',
        actionKey: 'ACTION_CLEAR_ARRIVAL_ON_FIRST_STOP',
      },
      {
        field: 'stops[0].departureTime',
        rejectedValue: null,
        issueKey: 'ISSUE_FIRST_STOP_LACKS_DEPARTURE',
        actionKey: 'ACTION_SET_DEPARTURE_ON_FIRST_STOP',
      },
      {
        field: 'stops[2].arrivalTime',
        rejectedValue: null,
        issueKey: 'ISSUE_LAST_STOP_LACKS_ARRIVAL',
        actionKey: 'ACTION_SET_ARRIVAL_ON_LAST_STOP',
      },
      {
        field: 'stops[2].departureTime',
        rejectedValue: '00:45',
        issueKey: 'ISSUE_LAST_STOP_HAS_DEPARTURE',
        actionKey: 'ACTION_CLEAR_DEPARTURE_ON_LAST_STOP',
      },
    ]);
  });

  it('distinguishes missing arrival and departure actions on an intermediate stop', () => {
    const stops = makeStops(3);
    stops[1] = { ...stops[1], arrivalTime: null, departureTime: null };

    expect(validateStopsStructure(stops, new Set(STATION_IDS))).toEqual([
      {
        field: 'stops[1].arrivalTime',
        rejectedValue: null,
        issueKey: 'ISSUE_INTERMEDIATE_STOP_TIMES_INCOMPLETE',
        actionKey: 'ACTION_SET_ARRIVAL_ON_STOP',
      },
      {
        field: 'stops[1].departureTime',
        rejectedValue: null,
        issueKey: 'ISSUE_INTERMEDIATE_STOP_TIMES_INCOMPLETE',
        actionKey: 'ACTION_SET_DEPARTURE_ON_STOP',
      },
    ]);
  });

  it('keeps position and day-offset ordering rules distinct', () => {
    const stops = makeStops(3);
    stops[1] = { ...stops[1], position: stops[0].position, dayOffset: -1 };

    expect(validateStopsStructure(stops, new Set(STATION_IDS))).toEqual([
      {
        field: 'stops[1].position',
        rejectedValue: 1,
        issueKey: 'ISSUE_STOP_POSITIONS_OUT_OF_ORDER',
        actionKey: 'ACTION_RENUMBER_STOP_POSITIONS',
      },
      {
        field: 'stops[1].dayOffset',
        rejectedValue: -1,
        issueKey: 'ISSUE_DAY_OFFSET_GOES_BACKWARDS',
        actionKey: 'ACTION_FIX_DAY_OFFSET',
      },
    ]);
  });
});

describe('validateNoDuplicateStations refs', () => {
  it('keeps the original zero-based first index for every later repetition', () => {
    const stops = makeStops(5);
    stops[3] = { ...stops[3], stationId: stops[1].stationId };
    stops[4] = { ...stops[4], stationId: stops[1].stationId };

    expect(validateNoDuplicateStations(stops)).toEqual([
      {
        field: 'stops[3].stationId',
        rejectedValue: stops[1].stationId,
        issueKey: 'ISSUE_STATION_REPEATED_ON_ROUTE',
        actionKey: 'ACTION_REMOVE_REPEATED_STATION',
        params: { firstStopIndex: '1' },
      },
      {
        field: 'stops[4].stationId',
        rejectedValue: stops[1].stationId,
        issueKey: 'ISSUE_STATION_REPEATED_ON_ROUTE',
        actionKey: 'ACTION_REMOVE_REPEATED_STATION',
        params: { firstStopIndex: '1' },
      },
    ]);
  });
});

describe('validateStopsChronology refs', () => {
  it('keeps the ISO rejected value when departure precedes arrival', () => {
    const stops = [
      {
        stationId: STATION_IDS[0],
        arrivalAt: new Date('2026-06-20T12:00:00Z'),
        departureAt: new Date('2026-06-20T11:59:00Z'),
      },
    ];

    expect(validateStopsChronology(stops)).toEqual([
      {
        field: 'stops[0].departureTime',
        rejectedValue: '2026-06-20T11:59:00.000Z',
        issueKey: 'ISSUE_DEPARTURE_BEFORE_ARRIVAL',
        actionKey: 'ACTION_FIX_DEPARTURE_AFTER_ARRIVAL',
      },
    ]);
  });

  it.each(['arrivalAt', 'departureAt'] as const)(
    'keeps the arrival rejected value when a connecting %s is missing',
    (missingTime) => {
      const stops = makeStops(2).map((stop) => ({
        stationId: stop.stationId,
        ...resolveStopTimes(
          '2026-06-20',
          stop.dayOffset,
          stop.arrivalTime,
          stop.departureTime,
        ),
      }));
      if (missingTime === 'arrivalAt') {
        stops[1].arrivalAt = null;
      } else {
        stops[0].departureAt = null;
      }

      expect(validateStopsChronology(stops)).toEqual([
        {
          field: 'stops[1].arrivalTime',
          rejectedValue: stops[1].arrivalAt,
          issueKey: 'ISSUE_STOP_TIMES_INVALID',
          actionKey: 'ACTION_SET_TIMES_ON_EVERY_INTERMEDIATE_STOP',
        },
      ]);
    },
  );
});

describe('validateFareRules refs', () => {
  it('reports missing travel classes before checking stops or fares', () => {
    expect(validateFareRules([], [], new Map())).toEqual([
      {
        field: 'coaches',
        rejectedValue: 0,
        issueKey: 'ISSUE_TRAIN_HAS_NO_TRAVEL_CLASSES',
        actionKey: 'ACTION_ADD_COACH_WITH_TRAVEL_CLASS',
      },
    ]);
  });

  it('reports the missing origin departure without attempting its fares', () => {
    const stops = makeStops(2).map((stop) => ({
      stationId: stop.stationId,
      ...resolveStopTimes(
        '2026-06-20',
        stop.dayOffset,
        stop.arrivalTime,
        stop.departureTime,
      ),
    }));
    stops[0].departureAt = null;

    expect(validateFareRules([coach(FIRST_CLASS)], stops, new Map())).toEqual([
      {
        field: 'stops[0].departureTime',
        rejectedValue: null,
        issueKey: 'ISSUE_ORIGIN_STOP_LACKS_DEPARTURE',
        actionKey: 'ACTION_SET_DEPARTURE_ON_STOP',
      },
    ]);
  });

  it('preserves both contained pairs with zero-based indices and string fare amounts', () => {
    const draftStops = makeStops(4);
    const stationIds = draftStops.map((stop) => stop.stationId);
    const stops = draftStops.map((stop) => ({
      stationId: stop.stationId,
      ...resolveStopTimes(
        '2026-06-20',
        stop.dayOffset,
        stop.arrivalTime,
        stop.departureTime,
      ),
    }));
    const fares = coveringFares(stationIds, [FIRST_CLASS]);
    fares.set(`${FIRST_CLASS}|${stationIds[1]}|${stationIds[3]}`, [
      { effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: 900 },
    ]);

    expect(validateFareRules([coach(FIRST_CLASS)], stops, fares)).toEqual([
      {
        field: `fares[${FIRST_CLASS}:${stationIds[1]}->${stationIds[3]}]`,
        rejectedValue: 900,
        issueKey: 'ISSUE_FARE_BELOW_CONTAINED_SEGMENT_FOR_PAIR',
        actionKey: 'ACTION_RAISE_FARE_FOR_PAIR',
        params: {
          travelClassId: FIRST_CLASS,
          outerOriginIndex: '1',
          outerDestinationIndex: '3',
          innerOriginIndex: '1',
          innerDestinationIndex: '2',
          outerFarePiastres: '900',
          innerFarePiastres: '1000',
        },
      },
      {
        field: `fares[${FIRST_CLASS}:${stationIds[1]}->${stationIds[3]}]`,
        rejectedValue: 900,
        issueKey: 'ISSUE_FARE_BELOW_CONTAINED_SEGMENT_FOR_PAIR',
        actionKey: 'ACTION_RAISE_FARE_FOR_PAIR',
        params: {
          travelClassId: FIRST_CLASS,
          outerOriginIndex: '1',
          outerDestinationIndex: '3',
          innerOriginIndex: '2',
          innerDestinationIndex: '3',
          outerFarePiastres: '900',
          innerFarePiastres: '1000',
        },
      },
    ]);
  });
});

describe('validateCapacityIssues refs', () => {
  it('keeps the coach number and sorted distinct repeated seat labels', () => {
    const coaches = [
      coach(FIRST_CLASS, {
        coachNumber: 7,
        rows: [
          { rowNumber: 1, leftSeats: ['10', '2'], rightSeats: ['2', '10'] },
          { rowNumber: 2, leftSeats: ['10', '2'], rightSeats: [] },
        ],
      }),
    ];

    expect(validateCapacityIssues(coaches, new Set([LAYOUT_ID]))).toEqual([
      {
        field: 'coaches[0].coachLayout.rows',
        rejectedValue: ['10', '2'],
        issueKey: 'ISSUE_COACH_SEATS_REPEATED',
        actionKey: 'ACTION_USE_UNIQUE_COACH_SEATS',
        params: { coachNumber: '7', seatNumbers: '10, 2' },
      },
    ]);
  });

  it.each([0, 1])(
    'reports no seats for %i empty coaches without changing the rejected count',
    (count) => {
      const coaches = Array.from({ length: count }, () =>
        coach(FIRST_CLASS, { rows: [] }),
      );

      expect(validateCapacityIssues(coaches, new Set([LAYOUT_ID]))).toEqual([
        {
          field: 'coaches',
          rejectedValue: count,
          issueKey: 'ISSUE_TRAIN_HAS_NO_SEATS',
          actionKey: 'ACTION_ADD_COACH_WITH_SEATS',
        },
      ]);
    },
  );
});
