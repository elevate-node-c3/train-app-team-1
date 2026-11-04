import type { CivilDateTime } from './catalog.dto.js';

/**
 * Cairo civil time, from the runtime's IANA tzdata and nothing else.
 *
 * Every departure and arrival the traveller sees is a Cairo wall-clock time
 * (BR-17), while every instant the database stores is a `timestamptz`. These
 * are the only two conversions between those worlds, so DST lives here or
 * nowhere.
 *
 * No date library: `Intl.DateTimeFormat` already consults the same tzdata that
 * luxon would delegate to for a named zone, so a dependency would buy
 * ergonomics rather than correctness. The surface is small enough to own.
 *
 * Durations are never computed from these civil fields -- see
 * `durationMinutesBetween`.
 */
export const CAIRO_TIME_ZONE = 'Africa/Cairo';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Built once: a formatter is expensive to construct and search formats two
 * instants per result, for a whole day of trips.
 */
const cairoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: CAIRO_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

interface CairoParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  /** Normalized to '+HH:MM' / '-HH:MM'. */
  offset: string;
}

/**
 * Reads the parts by `type` rather than by position, so the locale passed to
 * the formatter cannot change the result.
 */
function partsOf(instant: Date): CairoParts {
  const found: Record<string, string> = {};
  for (const part of cairoParts.formatToParts(instant)) {
    found[part.type] = part.value;
  }

  return {
    year: found.year,
    month: found.month,
    day: found.day,
    hour: found.hour,
    minute: found.minute,
    offset: normalizeOffset(found.timeZoneName),
  };
}

/**
 * `longOffset` yields 'GMT+03:00', and bare 'GMT' at zero offset. Shorter
 * spellings ('GMT+3') are tolerated so a runtime with a terser ICU build does
 * not silently produce an unparseable offset.
 */
function normalizeOffset(timeZoneName: string | undefined): string {
  const raw = (timeZoneName ?? '').replace('GMT', '').replace('UTC', '').trim();
  if (raw === '') return '+00:00';

  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  if (match === null) {
    throw new Error(`Unparseable ${CAIRO_TIME_ZONE} offset: ${timeZoneName}`);
  }

  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${hours.padStart(2, '0')}:${minutes}`;
}

function offsetToMs(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return sign * (hours * HOUR_MS + minutes * MINUTE_MS);
}

/** The Cairo calendar date an instant falls on, as 'YYYY-MM-DD'. */
export function cairoCivilDateOf(instant: Date): string {
  const { year, month, day } = partsOf(instant);
  return `${year}-${month}-${day}`;
}

/** The Cairo wall clock at an instant, with the offset in force there. */
export function cairoLocalTimeOf(instant: Date): {
  localTime: string;
  utcOffset: string;
} {
  const { hour, minute, offset } = partsOf(instant);
  return { localTime: `${hour}:${minute}`, utcOffset: offset };
}

/** Today's Cairo date. Takes `now` so callers stay testable and consistent. */
export function cairoToday(now: Date): string {
  return cairoCivilDateOf(now);
}

/**
 * The half-open instant interval `[startUtc, endUtc)` covering a Cairo civil
 * day. This is what turns BR-16's "the date it departs the passenger's origin"
 * into a SQL range over `trip_stop.departure_at`.
 *
 * The inverse (civil -> instant) has no primitive, so it is solved by
 * correction: guess the instant as if Cairo were UTC, read the offset actually
 * in force at that guess, correct, then read the offset again at the corrected
 * instant and correct once more. Two passes suffice because offsets move by at
 * most a few hours while transitions are at least a day apart.
 *
 * On a spring-forward day Cairo has no 00:00 -- the clock jumps from 00:00 to
 * 01:00 -- and this returns that day's genuine first instant (01:00 local),
 * which is what a day range needs. The result is therefore not always
 * "midnight", and the day is not always 24 hours long.
 */
export function cairoDayBounds(civilDate: string): {
  startUtc: Date;
  endUtc: Date;
} {
  return {
    startUtc: cairoDayStart(civilDate),
    endUtc: cairoDayStart(nextCivilDate(civilDate)),
  };
}

function cairoDayStart(civilDate: string): Date {
  const [year, month, day] = civilDate.split('-').map(Number);
  const asIfUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  const firstGuess = asIfUtc - offsetToMs(partsOf(new Date(asIfUtc)).offset);
  const corrected =
    asIfUtc - offsetToMs(partsOf(new Date(firstGuess)).offset);

  return new Date(corrected);
}

/**
 * Calendar arithmetic on a civil date, which has no time zone and therefore no
 * DST. Day `n` of a strip or a booking window is this, never an instant plus
 * `n * 86_400_000` -- that would drift by an hour twice a year.
 */
export function addCivilDays(civilDate: string, days: number): string {
  const [year, month, day] = civilDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  // Read back through UTC fields, not through Cairo: the arithmetic is on the
  // civil date itself.
  return [
    String(shifted.getUTCFullYear()).padStart(4, '0'),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function nextCivilDate(civilDate: string): string {
  return addCivilDays(civilDate, 1);
}

/**
 * Elapsed minutes between two instants.
 *
 * Deliberately arithmetic on epoch milliseconds, never on civil fields: that
 * is what makes a journey correct across midnight and across a DST change
 * (BR-17). A trip that leaves at 23:40 and arrives at 05:20 is 340 minutes,
 * and a trip spanning a spring-forward night is one hour shorter than its
 * wall clocks suggest.
 */
export function durationMinutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MINUTE_MS);
}

/** An instant as the wire's `CivilDateTime`. */
export function civilDateTimeOf(instant: Date): CivilDateTime {
  const { localTime, utcOffset } = cairoLocalTimeOf(instant);
  const localDate = cairoCivilDateOf(instant);

  return {
    localDate,
    localTime,
    utcOffset,
    iso: `${localDate}T${localTime}:00${utcOffset}`,
    timeZone: CAIRO_TIME_ZONE,
  };
}
