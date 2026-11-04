import type { BookingWindow } from './catalog.dto.js';
import { addCivilDays, cairoToday } from './cairo-time.js';

/**
 * The bookable range: today plus the next 29 Cairo calendar days.
 *
 * This is the single definition BR-16 asks for, and it lives in contracts
 * because five callers must agree on it or the product contradicts itself:
 * search validation refusing a date, the date strip deciding which five days
 * to offer, the refusal message quoting the last bookable date, the gateway
 * DTO rejecting early, and TA-16's trip generation deciding how far ahead to
 * materialize trips. `identity/password-policy.ts` is the precedent for
 * shared logic -- not just shapes -- living here.
 *
 * An app may not import another app, but every app may import contracts, which
 * is what makes one definition reachable from both the gateway and catalog.
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

/**
 * Whether a Cairo civil date is bookable at `now`.
 *
 * Lexicographic comparison is exact for zero-padded 'YYYY-MM-DD', so this
 * needs no parsing and cannot drift across a DST boundary.
 */
export function isWithinBookingWindow(civilDate: string, now: Date): boolean {
  const { firstBookableDate, lastBookableDate } = bookingWindowFor(now);
  return civilDate >= firstBookableDate && civilDate <= lastBookableDate;
}
