import type { BookingWindow } from './catalog.dto.js';
import { addCivilDays, cairoToday } from './cairo-time.js';

/**
 * The bookable range is today plus 29 Cairo calendar days.
 * Share this rule across generation, searches, pickers, and date messages.
 */
export const BOOKING_WINDOW_DAYS = 30;

/** The window in force at an instant, as the wire reports it. */
export function bookingWindowFor(now: Date): BookingWindow {
  const firstBookableDate = cairoToday(now);

  return {
    firstBookableDate,
    // Inclusive: 30 days total means the last one is 29 days after the first.
    lastBookableDate: addCivilDays(firstBookableDate, BOOKING_WINDOW_DAYS - 1),
    totalDays: BOOKING_WINDOW_DAYS,
  };
}

/** Compare padded Cairo dates directly to avoid timezone or DST shifts. */
export function isWithinBookingWindow(civilDate: string, now: Date): boolean {
  const { firstBookableDate, lastBookableDate } = bookingWindowFor(now);
  return civilDate >= firstBookableDate && civilDate <= lastBookableDate;
}
