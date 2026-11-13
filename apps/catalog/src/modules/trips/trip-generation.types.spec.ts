import { describe, expect, it } from 'vitest';

import { resolveStopTimes } from './trip-generation.types.js';

describe('resolveStopTimes', () => {
  // Use generation's DST fixture so publish validation resolves identical Cairo instants.
  it('turns a timetable crossing the spring-forward night into the same instants buildTripStops produces', () => {
    const departure = resolveStopTimes('2026-04-23', 0, null, '23:00');
    const arrival = resolveStopTimes('2026-04-23', 1, '04:10', null);

    // Departs 23:00 on 23 April (+02:00), arrives 04:10 on the 24th, after
    // the clocks jumped forward (+03:00).
    expect(departure.departureAt?.toISOString()).toBe(
      '2026-04-23T21:00:00.000Z',
    );
    expect(arrival.arrivalAt?.toISOString()).toBe('2026-04-24T01:10:00.000Z');

    const minutes =
      (arrival.arrivalAt!.getTime() - departure.departureAt!.getTime()) /
      60_000;
    expect(minutes).toBe(250);
  });

  it('gives each stop of an overnight trip its own calendar date', () => {
    const first = resolveStopTimes('2026-06-20', 0, null, '23:00');
    const second = resolveStopTimes('2026-06-20', 1, '04:10', '04:15');
    const third = resolveStopTimes('2026-06-20', 1, '09:30', null);

    expect(first.departureAt?.toISOString()).toBe('2026-06-20T20:00:00.000Z');
    expect(second.arrivalAt?.toISOString()).toBe('2026-06-21T01:10:00.000Z');
    expect(third.arrivalAt?.toISOString()).toBe('2026-06-21T06:30:00.000Z');
  });

  it('leaves a null time null rather than resolving a bogus instant', () => {
    const resolved = resolveStopTimes('2026-06-20', 0, null, null);

    expect(resolved.arrivalAt).toBeNull();
    expect(resolved.departureAt).toBeNull();
  });
});
