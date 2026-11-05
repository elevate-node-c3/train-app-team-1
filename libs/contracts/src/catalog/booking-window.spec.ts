import { describe, expect, it } from 'vitest';

import {
  BOOKING_WINDOW_DAYS,
  bookingWindowFor,
  isWithinBookingWindow,
} from './booking-window.js';
import { addCivilDays } from './cairo-time.js';

const MIDDAY_IN_JUNE = new Date('2026-06-15T09:00:00Z'); // 12:00 Cairo, +03:00

describe('the booking window', () => {
  it('spans today plus the next 29 Cairo days', () => {
    const window = bookingWindowFor(MIDDAY_IN_JUNE);

    expect(window.firstBookableDate).toBe('2026-06-15');
    expect(window.lastBookableDate).toBe('2026-07-14');
    expect(window.totalDays).toBe(BOOKING_WINDOW_DAYS);
    expect(BOOKING_WINDOW_DAYS).toBe(30);
  });

  it('puts exactly 29 days between the first and last bookable date', () => {
    const { firstBookableDate, lastBookableDate } =
      bookingWindowFor(MIDDAY_IN_JUNE);

    expect(addCivilDays(firstBookableDate, BOOKING_WINDOW_DAYS - 1)).toBe(
      lastBookableDate,
    );
  });

  // The window is a Cairo calendar fact, so it must roll when Cairo's date
  // rolls -- not when UTC's does. At 22:30Z on 30 June, Cairo is already in
  // July, and a traveller there must be able to search 29 July.
  it('rolls at Cairo midnight, not UTC midnight', () => {
    const window = bookingWindowFor(new Date('2026-06-30T22:30:00Z'));

    expect(window.firstBookableDate).toBe('2026-07-01');
    expect(window.lastBookableDate).toBe('2026-07-30');
  });

  describe('isWithinBookingWindow', () => {
    it('accepts today and rejects yesterday', () => {
      expect(isWithinBookingWindow('2026-06-15', MIDDAY_IN_JUNE)).toBe(true);
      expect(isWithinBookingWindow('2026-06-14', MIDDAY_IN_JUNE)).toBe(false);
    });

    // The inclusive edge the refusal message has to be able to quote.
    it('accepts the last bookable date and rejects the day after', () => {
      expect(isWithinBookingWindow('2026-07-14', MIDDAY_IN_JUNE)).toBe(true);
      expect(isWithinBookingWindow('2026-07-15', MIDDAY_IN_JUNE)).toBe(false);
    });

    it('rejects a date far in the past or future', () => {
      expect(isWithinBookingWindow('2025-01-01', MIDDAY_IN_JUNE)).toBe(false);
      expect(isWithinBookingWindow('2030-01-01', MIDDAY_IN_JUNE)).toBe(false);
    });
  });
});
