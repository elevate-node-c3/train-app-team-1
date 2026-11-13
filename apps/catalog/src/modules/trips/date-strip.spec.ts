import { addCivilDays, bookingWindowFor } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { DATE_STRIP_LENGTH, buildDateStrip } from './date-strip.js';

/** 12:00 Cairo. The window is 2026-06-15 .. 2026-07-14. */
const NOW = new Date('2026-06-15T09:00:00Z');
const TODAY = '2026-06-15';
const LAST_BOOKABLE = '2026-07-14';

const datesOf = (selected: string, now: Date = NOW): string[] =>
  buildDateStrip(selected, now).map((day) => day.date);

describe('the date strip', () => {
  it('is five days long and marks exactly one of them selected', () => {
    const strip = buildDateStrip('2026-06-20', NOW);

    expect(strip).toHaveLength(DATE_STRIP_LENGTH);
    expect(strip.filter((day) => day.selected)).toHaveLength(1);
    expect(strip.find((day) => day.selected)?.date).toBe('2026-06-20');
  });

  it('centres the selected day when the window allows', () => {
    expect(datesOf('2026-06-20')).toEqual([
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
      '2026-06-22',
    ]);
  });

  // Slide the selected day off-center at an edge to keep five choices.
  it('slides off-centre rather than showing a day before today', () => {
    expect(datesOf(TODAY)).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
    ]);
    expect(buildDateStrip(TODAY, NOW)[0].selected).toBe(true);
  });

  it('still starts at today when the selected day is tomorrow', () => {
    const strip = buildDateStrip(addCivilDays(TODAY, 1), NOW);

    expect(strip[0].date).toBe(TODAY);
    expect(strip[1].selected).toBe(true);
  });

  it('slides off-centre rather than passing the last bookable date', () => {
    const strip = buildDateStrip(LAST_BOOKABLE, NOW);

    expect(strip.map((day) => day.date)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
      '2026-07-14',
    ]);
    expect(strip[4].selected).toBe(true);
  });

  it('never offers a day outside the booking window, for any selected day', () => {
    const { firstBookableDate, lastBookableDate } = bookingWindowFor(NOW);

    for (let offset = 0; offset < 30; offset += 1) {
      const strip = buildDateStrip(addCivilDays(TODAY, offset), NOW);

      expect(strip).toHaveLength(DATE_STRIP_LENGTH);
      for (const day of strip) {
        expect(day.date >= firstBookableDate).toBe(true);
        expect(day.date <= lastBookableDate).toBe(true);
        expect(day.bookable).toBe(true);
      }
    }
  });

  it('marks only today as today', () => {
    const strip = buildDateStrip('2026-06-16', NOW);
    const todayFlags = strip.filter((day) => day.isToday);

    expect(todayFlags).toHaveLength(1);
    expect(todayFlags[0].date).toBe(TODAY);
  });

  it('has no today when the strip has slid past it', () => {
    expect(buildDateStrip(LAST_BOOKABLE, NOW).some((day) => day.isToday)).toBe(
      false,
    );
  });

  it('returns consecutive civil dates across a DST transition', () => {
    // DST crossings must preserve five consecutive Cairo calendar days.
    const inApril = new Date('2026-04-23T09:00:00Z');
    const strip = buildDateStrip('2026-04-24', inApril);

    expect(strip).toHaveLength(DATE_STRIP_LENGTH);
    for (let index = 0; index + 1 < strip.length; index += 1) {
      expect(addCivilDays(strip[index].date, 1)).toBe(strip[index + 1].date);
    }
  });

  it('is a function of now, so the same selection rolls with the window', () => {
    // Do not cache the strip; tomorrow's choices must not include yesterday.
    const tomorrow = new Date('2026-06-16T09:00:00Z');

    expect(datesOf(TODAY, tomorrow)[0]).toBe('2026-06-16');
  });
});
