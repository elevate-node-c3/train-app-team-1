import type { DateStripDay } from '@app/contracts';
import { addCivilDays, bookingWindowFor, cairoToday } from '@app/contracts';

/** Five days, as the design's picker shows. */
export const DATE_STRIP_LENGTH = 5;

/**
 * The days the picker offers around a selected date.
 *
 * The server decides these rather than the client so the booking-window rule
 * lives in one place: a client computing "selected ± 2" would offer yesterday,
 * or a date past the window, and would have to re-implement the Cairo calendar
 * to avoid it.
 *
 * Near either edge the strip SLIDES instead of shrinking, so the selected day
 * moves off-centre and the traveller still gets five choices. Choosing another
 * day of the strip is simply another search.
 *
 * Never cached: it is a function of `now`, so the same request tomorrow must
 * not be able to offer yesterday.
 */
export function buildDateStrip(selectedDate: string, now: Date): DateStripDay[] {
  const { firstBookableDate, lastBookableDate } = bookingWindowFor(now);
  const today = cairoToday(now);

  const centred = addCivilDays(selectedDate, -Math.floor(DATE_STRIP_LENGTH / 2));
  const latestStart = addCivilDays(lastBookableDate, -(DATE_STRIP_LENGTH - 1));

  // Clamp the START, which slides the whole strip. Clamping each day instead
  // would collapse duplicates at the edge.
  let start = centred;
  if (start > latestStart) start = latestStart;
  if (start < firstBookableDate) start = firstBookableDate;

  const days: DateStripDay[] = [];
  for (let offset = 0; offset < DATE_STRIP_LENGTH; offset += 1) {
    const date = addCivilDays(start, offset);

    // Guards a window shorter than the strip, which cannot happen while
    // BOOKING_WINDOW_DAYS is 30 but would silently offer unbookable days if it
    // ever shrank.
    if (date > lastBookableDate) break;

    days.push({
      date,
      selected: date === selectedDate,
      isToday: date === today,
      bookable: true,
    });
  }

  return days;
}
