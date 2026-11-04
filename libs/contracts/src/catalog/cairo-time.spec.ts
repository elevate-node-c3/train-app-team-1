import { describe, expect, it } from 'vitest';

import {
  CAIRO_TIME_ZONE,
  cairoCivilDateOf,
  cairoDayBounds,
  cairoLocalTimeOf,
  cairoToday,
  civilDateTimeOf,
  durationMinutesBetween,
} from './cairo-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every Cairo civil date in a year, as 'YYYY-MM-DD'. */
function civilDatesIn(year: number): string[] {
  const dates: string[] = [];
  for (
    let instant = Date.UTC(year, 0, 1, 12);
    instant < Date.UTC(year + 1, 0, 1, 12);
    instant += DAY_MS
  ) {
    dates.push(cairoCivilDateOf(new Date(instant)));
  }
  return dates;
}

describe('Cairo local time', () => {
  // These two instants are the ICU canary. If the runtime ships small-ICU,
  // Africa/Cairo collapses to UTC and both assertions fail -- which is the
  // signal to add full-icu or move the image to a slim base, not to relax the
  // test. Egypt reinstated DST in 2023, so both halves of the year matter.
  it('reads the offset from tzdata, in and out of DST', () => {
    expect(cairoLocalTimeOf(new Date('2025-04-25T10:00:00Z'))).toEqual({
      localTime: '13:00',
      utcOffset: '+03:00',
    });

    expect(cairoLocalTimeOf(new Date('2025-01-15T10:00:00Z'))).toEqual({
      localTime: '12:00',
      utcOffset: '+02:00',
    });
  });

  it('rolls the civil date at Cairo midnight, not UTC midnight', () => {
    // 22:30 UTC on 30 June is already 01:30 on 1 July in Cairo (+03:00).
    expect(cairoCivilDateOf(new Date('2026-06-30T22:30:00Z'))).toBe(
      '2026-07-01',
    );

    // 21:30 UTC in January is still the same Cairo day (+02:00 -> 23:30).
    expect(cairoCivilDateOf(new Date('2026-01-15T21:30:00Z'))).toBe(
      '2026-01-15',
    );
  });

  it('reports today as a Cairo date', () => {
    expect(cairoToday(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01');
  });

  it('bounds a civil day with instants that round-trip to that day', () => {
    const { startUtc, endUtc } = cairoDayBounds('2026-03-15');

    expect(cairoCivilDateOf(startUtc)).toBe('2026-03-15');
    expect(cairoLocalTimeOf(startUtc).localTime).toBe('00:00');
    // Half-open: the end bound is the next day's first instant.
    expect(cairoCivilDateOf(endUtc)).toBe('2026-03-16');
    expect(cairoLocalTimeOf(endUtc).localTime).toBe('00:00');
  });

  it('makes each day end exactly where the next begins', () => {
    const dates = civilDatesIn(2026);

    for (let index = 0; index + 1 < dates.length; index += 1) {
      expect(cairoDayBounds(dates[index]).endUtc.getTime()).toBe(
        cairoDayBounds(dates[index + 1]).startUtc.getTime(),
      );
    }
  });

  // The real DST assertion, and the reason the bounds cannot be "start + 24h".
  // A naive implementation makes every day 24h and fails both counts.
  it('finds exactly one 23-hour and one 25-hour day in a DST year', () => {
    const lengths = civilDatesIn(2026).map((date) => {
      const { startUtc, endUtc } = cairoDayBounds(date);
      return (endUtc.getTime() - startUtc.getTime()) / (60 * 60 * 1000);
    });

    expect(lengths.filter((hours) => hours === 23)).toHaveLength(1);
    expect(lengths.filter((hours) => hours === 25)).toHaveLength(1);
    expect(lengths.filter((hours) => hours === 24)).toHaveLength(
      lengths.length - 2,
    );
  });

  describe('duration', () => {
    it('counts minutes across midnight', () => {
      // 23:40 Cairo to 05:20 the next morning: the overnight Aswan service.
      const departure = new Date('2026-03-15T21:40:00Z'); // 23:40 +02:00
      const arrival = new Date('2026-03-16T03:20:00Z'); // 05:20 +02:00

      expect(durationMinutesBetween(departure, arrival)).toBe(340);
    });

    it('counts real elapsed minutes across a DST transition', () => {
      // The spring-forward day is 23 civil hours long. Measured from instants
      // it is 1380 minutes; wall-clock arithmetic would wrongly say 1440.
      const springForward = civilDatesIn(2026).find((date) => {
        const { startUtc, endUtc } = cairoDayBounds(date);
        return endUtc.getTime() - startUtc.getTime() === 23 * 60 * 60 * 1000;
      });

      expect(springForward).toBeDefined();

      const { startUtc, endUtc } = cairoDayBounds(springForward!);
      expect(durationMinutesBetween(startUtc, endUtc)).toBe(1380);
    });

    it('is zero for the same instant and negative when reversed', () => {
      const instant = new Date('2026-03-15T10:00:00Z');
      const later = new Date('2026-03-15T11:00:00Z');

      expect(durationMinutesBetween(instant, instant)).toBe(0);
      expect(durationMinutesBetween(later, instant)).toBe(-60);
    });
  });

  describe('civilDateTimeOf', () => {
    it('composes a wire value whose iso agrees with its parts', () => {
      const result = civilDateTimeOf(new Date('2026-04-25T10:30:00Z'));

      expect(result.timeZone).toBe(CAIRO_TIME_ZONE);
      expect(result.iso).toBe(
        `${result.localDate}T${result.localTime}:00${result.utcOffset}`,
      );
      // And the iso parses back to the instant it came from, which is what
      // makes it safe for a client that needs the instant itself.
      expect(new Date(result.iso).getTime()).toBe(
        new Date('2026-04-25T10:30:00Z').getTime(),
      );
    });
  });
});
