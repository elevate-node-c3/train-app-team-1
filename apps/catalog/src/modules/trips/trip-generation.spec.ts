import { describe, expect, it } from 'vitest';

import { TimetableEntity, Weekday } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import { TripsService } from './trips.service.js';

const CAIRO = '11111111-1111-4111-8111-111111111111';
const ASSIUT = '22222222-2222-4222-8222-222222222222';
const ASWAN = '33333333-3333-4333-8333-333333333333';

const FIRST_CLASS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_CLASS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Only the pure logic is exercised here, so the ports stay unused stubs. */
function makeService(): TripsService {
  return new TripsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function stop(overrides: Partial<TimetableStopEntity>): TimetableStopEntity {
  return {
    stationId: CAIRO,
    station: { id: CAIRO } as never,
    position: 1,
    dayOffset: 0,
    arrivalTime: null,
    departureTime: null,
    ...overrides,
  } as TimetableStopEntity;
}

/** Cairo 23:00 -> Assiut 04:10 -> Aswan 09:30: the story's overnight train. */
function overnightStops(): TimetableStopEntity[] {
  return [
    stop({ stationId: CAIRO, position: 1, departureTime: '23:00' }),
    stop({
      stationId: ASSIUT,
      station: { id: ASSIUT } as never,
      position: 2,
      dayOffset: 1,
      arrivalTime: '04:10',
      departureTime: '04:15',
    }),
    stop({
      stationId: ASWAN,
      station: { id: ASWAN } as never,
      position: 3,
      dayOffset: 1,
      arrivalTime: '09:30',
    }),
  ];
}

function coach(travelClassId: string): TrainCoachEntity {
  return {
    position: 1,
    coachNumber: 1,
    travelClass: { id: travelClassId, nameEn: 'c', nameAr: 'ج' },
    coachLayout: { id: 'layout', layoutName: 'l', rows: [] },
  } as unknown as TrainCoachEntity;
}

function timetable(overrides: Partial<TimetableEntity> = {}): TimetableEntity {
  return {
    id: 'tt-1',
    effectiveFrom: '2026-01-01',
    effectiveUntil: null,
    runningDays: [0, 1, 2, 3, 4, 5, 6],
    version: 1,
    status: 'published',
    ...overrides,
  } as TimetableEntity;
}

/** A fare index built by hand, in the shape buildFareIndex produces. */
function fareIndex(
  entries: [string, string, string, number][],
): Map<string, { effectiveFrom: Date; amountPiastres: number }[]> {
  const index = new Map<
    string,
    { effectiveFrom: Date; amountPiastres: number }[]
  >();

  for (const [travelClassId, origin, destination, amount] of entries) {
    index.set(`${travelClassId}|${origin}|${destination}`, [
      { effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: amount },
    ]);
  }

  return index;
}

/** Full, monotonic coverage of the overnight route for one class. */
function coveringFares(travelClassId: string, scale = 1) {
  return fareIndex([
    [travelClassId, CAIRO, ASSIUT, 5000 * scale],
    [travelClassId, CAIRO, ASWAN, 12000 * scale],
    [travelClassId, ASSIUT, ASWAN, 7000 * scale],
  ]);
}

describe('Trip generation', () => {
  describe('buildTripStops', () => {
    it('gives each stop of an overnight trip its own calendar date', () => {
      const stops = makeService().buildTripStops(
        overnightStops(),
        '2026-06-20',
      );

      // Departs 20 June, arrives 21 June. Cairo is +03:00 in June.
      expect(stops[0].departureAt?.toISOString()).toBe(
        '2026-06-20T20:00:00.000Z',
      );
      expect(stops[1].arrivalAt?.toISOString()).toBe(
        '2026-06-21T01:10:00.000Z',
      );
      expect(stops[2].arrivalAt?.toISOString()).toBe(
        '2026-06-21T06:30:00.000Z',
      );
    });

    it('keeps the journey in order across the midnight it crosses', () => {
      const stops = makeService().buildTripStops(
        overnightStops(),
        '2026-06-20',
      );

      expect(stops[1].arrivalAt!.getTime()).toBeGreaterThan(
        stops[0].departureAt!.getTime(),
      );
      expect(stops[2].arrivalAt!.getTime()).toBeGreaterThan(
        stops[1].departureAt!.getTime(),
      );
    });

    it('leaves the first stop without an arrival and the last without a departure', () => {
      const stops = makeService().buildTripStops(
        overnightStops(),
        '2026-06-20',
      );

      expect(stops[0].arrivalAt).toBeNull();
      expect(stops[2].departureAt).toBeNull();
    });

    it('turns a timetable crossing the spring-forward night into real instants', () => {
      // Departs 23:00 on 23 April (+02:00), arrives 04:10 on the 24th, after
      // the clocks jumped forward (+03:00). Four hours ten by the clock, but
      // three hours ten of actual travel.
      const stops = makeService().buildTripStops(
        overnightStops(),
        '2026-04-23',
      );

      expect(stops[0].departureAt?.toISOString()).toBe(
        '2026-04-23T21:00:00.000Z',
      );
      expect(stops[1].arrivalAt?.toISOString()).toBe(
        '2026-04-24T01:10:00.000Z',
      );

      const minutes =
        (stops[1].arrivalAt!.getTime() - stops[0].departureAt!.getTime()) /
        60_000;
      expect(minutes).toBe(250);
    });
  });

  describe('isTimetableRunningOnDate', () => {
    it('runs a Friday-only timetable on Fridays and no other day', () => {
      const service = makeService();
      const fridaysOnly = timetable({ runningDays: [Weekday.Friday] });

      // 19 June 2026 is a Friday.
      expect(service.isTimetableRunningOnDate(fridaysOnly, '2026-06-19')).toBe(
        true,
      );
      for (const date of [
        '2026-06-18',
        '2026-06-20',
        '2026-06-21',
        '2026-06-22',
      ]) {
        expect(service.isTimetableRunningOnDate(fridaysOnly, date)).toBe(false);
      }
    });

    it('includes the effective-from date and excludes the day before', () => {
      const service = makeService();
      const limited = timetable({ effectiveFrom: '2026-06-20' });

      expect(service.isTimetableRunningOnDate(limited, '2026-06-20')).toBe(
        true,
      );
      expect(service.isTimetableRunningOnDate(limited, '2026-06-19')).toBe(
        false,
      );
    });

    it('includes the effective-until date and excludes the day after', () => {
      const service = makeService();
      const limited = timetable({ effectiveUntil: '2026-06-20' });

      expect(service.isTimetableRunningOnDate(limited, '2026-06-20')).toBe(
        true,
      );
      expect(service.isTimetableRunningOnDate(limited, '2026-06-21')).toBe(
        false,
      );
    });

    it('refuses a date that is not a date', () => {
      expect(
        makeService().isTimetableRunningOnDate(timetable(), 'not-a-date'),
      ).toBe(false);
    });
  });

  describe('validateTimetableStops', () => {
    it('accepts a well-formed overnight route', () => {
      expect(() =>
        makeService().validateTimetableStops(overnightStops()),
      ).not.toThrow();
    });

    it('refuses a route with one stop', () => {
      expect(() =>
        makeService().validateTimetableStops([
          stop({ departureTime: '23:00' }),
        ]),
      ).toThrow(/at least two stops/);
    });

    it('refuses an arrival at the first stop or a departure at the last', () => {
      const service = makeService();

      const arrivingFirst = overnightStops();
      arrivingFirst[0].arrivalTime = '22:50';
      expect(() => service.validateTimetableStops(arrivingFirst)).toThrow(
        /First stop must not have arrival/,
      );

      const departingLast = overnightStops();
      departingLast[2].departureTime = '09:40';
      expect(() => service.validateTimetableStops(departingLast)).toThrow(
        /Last stop must not have departure/,
      );
    });

    it('refuses an intermediate stop missing either time', () => {
      const stops = overnightStops();
      stops[1].departureTime = null;

      expect(() => makeService().validateTimetableStops(stops)).toThrow(
        /Intermediate stop must have arrival and departure/,
      );
    });

    it('refuses positions that do not increase', () => {
      const stops = overnightStops();
      stops[2].position = 2;

      expect(() => makeService().validateTimetableStops(stops)).toThrow(
        /not correctly ordered/,
      );
    });

    it('refuses a day offset that goes backwards', () => {
      const stops = overnightStops();
      stops[2].dayOffset = 0;

      expect(() => makeService().validateTimetableStops(stops)).toThrow(
        /day offset cannot go backwards/,
      );
    });

    it('accepts a same-day route where every offset is zero', () => {
      const stops = overnightStops();
      stops[1].dayOffset = 0;
      stops[2].dayOffset = 0;

      expect(() => makeService().validateTimetableStops(stops)).not.toThrow();
    });
  });

  describe('validateTripStopTimes', () => {
    it('accepts the overnight trip it was built from', () => {
      const service = makeService();
      const stops = service.buildTripStops(overnightStops(), '2026-06-20');

      expect(() => service.validateTripStopTimes(stops)).not.toThrow();
    });

    it('refuses a stop whose departure precedes its arrival', () => {
      const service = makeService();
      const stops = service.buildTripStops(overnightStops(), '2026-06-20');
      stops[1].departureAt = new Date(stops[1].arrivalAt!.getTime() - 60_000);

      expect(() => service.validateTripStopTimes(stops)).toThrow(
        /Departure cannot be before arrival/,
      );
    });

    it('refuses stops that go backwards in time', () => {
      const service = makeService();
      const stops = service.buildTripStops(overnightStops(), '2026-06-20');
      stops[2].arrivalAt = new Date(stops[1].departureAt!.getTime() - 60_000);

      expect(() => service.validateTripStopTimes(stops)).toThrow(
        /not in chronological order/,
      );
    });
  });

  describe('validateTripFares', () => {
    const service = makeService();
    const stops = service.buildTripStops(overnightStops(), '2026-06-20');

    it('accepts full, monotonic coverage for every class the train carries', () => {
      const fares = new Map([
        ...coveringFares(FIRST_CLASS, 2),
        ...coveringFares(SECOND_CLASS),
      ]);

      expect(() =>
        service.validateTripFares(
          [coach(FIRST_CLASS), coach(SECOND_CLASS)],
          stops,
          fares,
        ),
      ).not.toThrow();
    });

    it('refuses a route with one pair missing a fare', () => {
      const fares = coveringFares(FIRST_CLASS);
      fares.delete(`${FIRST_CLASS}|${ASSIUT}|${ASWAN}`);

      expect(() =>
        service.validateTripFares([coach(FIRST_CLASS)], stops, fares),
      ).toThrow(/missing or invalid fare/);
    });

    it('names every missing pair, not just the first', () => {
      const fares = coveringFares(FIRST_CLASS);
      fares.delete(`${FIRST_CLASS}|${CAIRO}|${ASSIUT}`);
      fares.delete(`${FIRST_CLASS}|${ASSIUT}|${ASWAN}`);

      expect(() =>
        service.validateTripFares([coach(FIRST_CLASS)], stops, fares),
      ).toThrow(/missing or invalid fare[\s\S]*missing or invalid fare/);
    });

    it('refuses a class the train carries but the fares do not cover', () => {
      expect(() =>
        service.validateTripFares(
          [coach(FIRST_CLASS), coach(SECOND_CLASS)],
          stops,
          coveringFares(FIRST_CLASS),
        ),
      ).toThrow(new RegExp(SECOND_CLASS));
    });

    it('refuses a sub-segment that costs more than the segment containing it', () => {
      // Cairo -> Assiut is dearer than Cairo -> Aswan, which contains it.
      const fares = fareIndex([
        [FIRST_CLASS, CAIRO, ASSIUT, 13000],
        [FIRST_CLASS, CAIRO, ASWAN, 12000],
        [FIRST_CLASS, ASSIUT, ASWAN, 7000],
      ]);

      expect(() =>
        service.validateTripFares([coach(FIRST_CLASS)], stops, fares),
      ).toThrow(/is less than the segment it contains/);
    });

    it('accepts a longer segment priced exactly as its sub-segment', () => {
      const fares = fareIndex([
        [FIRST_CLASS, CAIRO, ASSIUT, 7000],
        [FIRST_CLASS, CAIRO, ASWAN, 7000],
        [FIRST_CLASS, ASSIUT, ASWAN, 7000],
      ]);

      expect(() =>
        service.validateTripFares([coach(FIRST_CLASS)], stops, fares),
      ).not.toThrow();
    });

    it('refuses a zero or negative fare as missing', () => {
      const fares = coveringFares(FIRST_CLASS);
      fares.set(`${FIRST_CLASS}|${CAIRO}|${ASSIUT}`, [
        { effectiveFrom: new Date('2020-01-01T00:00:00Z'), amountPiastres: 0 },
      ]);

      expect(() =>
        service.validateTripFares([coach(FIRST_CLASS)], stops, fares),
      ).toThrow(/missing or invalid fare/);
    });

    it('ignores a fare that had not taken effect by the departure', () => {
      const fares = coveringFares(FIRST_CLASS);
      fares.set(`${FIRST_CLASS}|${CAIRO}|${ASSIUT}`, [
        {
          effectiveFrom: new Date('2030-01-01T00:00:00Z'),
          amountPiastres: 5000,
        },
      ]);

      expect(() =>
        service.validateTripFares([coach(FIRST_CLASS)], stops, fares),
      ).toThrow(/missing or invalid fare/);
    });

    it('reads the fare in force at the departure when a pair has history', () => {
      // Newest first, as buildFareIndex sorts them. The 2030 row must lose to
      // the 2020 one for a June 2026 departure, and 9000 keeps it monotonic.
      const fares = coveringFares(FIRST_CLASS);
      fares.set(`${FIRST_CLASS}|${CAIRO}|${ASSIUT}`, [
        {
          effectiveFrom: new Date('2030-01-01T00:00:00Z'),
          amountPiastres: 99000,
        },
        {
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          amountPiastres: 9000,
        },
      ]);

      expect(() =>
        service.validateTripFares([coach(FIRST_CLASS)], stops, fares),
      ).not.toThrow();
    });

    it('refuses a train with no travel classes', () => {
      expect(() =>
        service.validateTripFares([], stops, coveringFares(FIRST_CLASS)),
      ).toThrow(/no travel classes/);
    });
  });

  describe('calculateCapacity', () => {
    it('counts both sides of every row of every coach', () => {
      const twoByTwo = coach(FIRST_CLASS);
      twoByTwo.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3', '4'] },
        { rowNumber: 2, leftSeats: ['5', '6'], rightSeats: ['7', '8'] },
      ];

      expect(makeService().calculateCapacity([twoByTwo])).toBe(8);
    });

    it('counts a 2+1 layout, where one side of every row is a single seat', () => {
      const twoByOne = coach(FIRST_CLASS);
      twoByOne.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3'] },
        { rowNumber: 2, leftSeats: ['4', '5'], rightSeats: ['6'] },
        { rowNumber: 3, leftSeats: ['7', '8'], rightSeats: ['9'] },
      ];

      expect(makeService().calculateCapacity([twoByOne])).toBe(9);
    });

    it('sums across coaches of different classes', () => {
      const first = coach(FIRST_CLASS);
      first.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3'] },
      ];
      const second = coach(SECOND_CLASS);
      second.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3', '4'] },
      ];

      expect(makeService().calculateCapacity([first, second])).toBe(7);
    });

    it('refuses a train whose coaches have no seats', () => {
      expect(() => makeService().calculateCapacity([coach(FIRST_CLASS)])).toThrow(
        /no seats/,
      );
    });

    // A repeat would inflate capacity, and from Sprint 3 would make inventory
    // create two seats with the same label.
    it('refuses a seat number repeated in another row of the same coach', () => {
      const repeating = coach(FIRST_CLASS);
      repeating.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3', '4'] },
        { rowNumber: 2, leftSeats: ['4', '5'], rightSeats: ['6', '7'] },
      ];

      expect(() => makeService().calculateCapacity([repeating])).toThrow(
        /Coach 1 repeats seat 4/,
      );
    });

    it('refuses a seat number repeated across the aisle of one row', () => {
      const repeating = coach(FIRST_CLASS);
      repeating.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['2', '3'] },
      ];

      expect(() => makeService().calculateCapacity([repeating])).toThrow(
        /repeats seat 2/,
      );
    });

    it('names every repeated seat, not just the first', () => {
      const repeating = coach(FIRST_CLASS);
      repeating.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3'] },
        { rowNumber: 2, leftSeats: ['1', '2'], rightSeats: ['4'] },
      ];

      expect(() => makeService().calculateCapacity([repeating])).toThrow(
        /repeats seat 1, 2/,
      );
    });

    // Uniqueness is within a coach: "Coach 5, Seat 44" names the seat.
    it('allows two coaches to use the same seat numbers', () => {
      const first = coach(FIRST_CLASS);
      first.coachNumber = 1;
      first.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3', '4'] },
      ];
      const second = coach(SECOND_CLASS);
      second.coachNumber = 2;
      second.coachLayout.rows = [
        { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3', '4'] },
      ];

      expect(makeService().calculateCapacity([first, second])).toBe(8);
    });
  });
});
