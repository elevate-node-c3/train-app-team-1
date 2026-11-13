import type { DateStripDay } from '@app/contracts';
import { addCivilDays, bookingWindowFor, cairoToday } from '@app/contracts';

/** Offer five days when the booking window allows it. */
export const DATE_STRIP_LENGTH = 5;

/**
 * Compute in Cairo on the server to keep choices inside the booking window.
 * Slide at either edge rather than shrinking; keep five choices when the window
 * allows. Choosing a day starts another search.
 * Never cache the strip: tomorrow's response must not offer yesterday.
 */
export function buildDateStrip(
  selectedDate: string,
  now: Date,
): DateStripDay[] {
  const { firstBookableDate, lastBookableDate } = bookingWindowFor(now);
  const today = cairoToday(now);

  const centred = addCivilDays(
    selectedDate,
    -Math.floor(DATE_STRIP_LENGTH / 2),
  );
  const latestStart = addCivilDays(lastBookableDate, -(DATE_STRIP_LENGTH - 1));

  // Clamp the start, not each day, to slide the strip without duplicates.
  let start = centred;
  if (start > latestStart) start = latestStart;
  if (start < firstBookableDate) start = firstBookableDate;

  const days: DateStripDay[] = [];
  for (let offset = 0; offset < DATE_STRIP_LENGTH; offset += 1) {
    const date = addCivilDays(start, offset);

    // If the window shrinks below five days, do not offer dates outside it.
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
