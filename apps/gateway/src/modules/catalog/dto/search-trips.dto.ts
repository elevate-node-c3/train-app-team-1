import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { EventLanguage } from '@app/contracts';

/** A time of day is 00:00..23:59, so a minute index never reaches 1440. */
export const MINUTES_IN_A_DAY = 24 * 60;

export const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A time of day a traveller typed: '06:00', '23:59'. */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** '٠'..'٩' and the Persian forms, which Arabic keyboards also produce. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/** The sort orders the wire accepts (BR-18). */
export const SEARCH_SORTS = [
  'SEARCH_SORT_DEPARTURE_ASC',
  'SEARCH_SORT_DURATION_ASC',
  'SEARCH_SORT_FARE_ASC',
  'SEARCH_SORT_ARRIVAL_ASC',
] as const;

/**
 * Every Arabic-Indic digit in a string, as its ASCII counterpart.
 *
 * Separate from `toAsciiDigits` because the time filters need the converted
 * *string* -- '٠٦:٠٠' is a valid time a traveller typed, and it is not a bare
 * number, so the number-or-original rule below would hand back the Arabic form
 * unchanged.
 */
function asciiDigitsOf(value: string): string {
  return value
    .trim()
    .replace(ARABIC_INDIC_DIGITS, (digit) =>
      String(
        digit.charCodeAt(0) >= 0x06f0
          ? digit.charCodeAt(0) - 0x06f0
          : digit.charCodeAt(0) - 0x0660,
      ),
    );
}

/**
 * Turns Arabic-Indic digits into ASCII before validation.
 *
 * A traveller on an Arabic keyboard types ٨٠٣, and the rule says that is a
 * valid train number. Normalizing at the edge means catalog only ever sees
 * ASCII and needs no opinion about scripts -- which is why its own validator
 * refuses a non-number rather than trying to interpret one.
 */
export function toAsciiDigits(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const ascii = asciiDigitsOf(value);

  // Left as the original string when it is not a number at all, so
  // class-validator reports the field rather than silently producing NaN.
  return /^\d+$/.test(ascii) ? Number(ascii) : value;
}

/**
 * A traveller types a clock; the wire speaks minutes since midnight.
 *
 * Converted here rather than in catalog, because this is the only place that
 * knows a human typed it: `SearchFilters.departAfterMinutes` is an integer by
 * design, and a service that accepted both would have two representations of
 * one idea. An unparseable value is left alone so class-validator reports the
 * field instead of silently filtering by NaN.
 */
export function clockTimeToMinutes(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const match = CLOCK_TIME_PATTERN.exec(asciiDigitsOf(value));
  if (match === null) return value;

  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A query-string flag as a boolean.
 *
 * Only the two words are accepted. Anything else is left alone so
 * `@IsBoolean` reports the field -- the usual truthiness rules would read
 * `excludeSoldOut=no` as `true`, which is the opposite of what was asked.
 */
export function toBoolean(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;

  return value;
}

/** A query string carries a list as CSV; the wire wants an array. */
export function csvToArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // An empty or all-whitespace value means "no preference", which is an absent
  // filter rather than a filter matching nothing.
  return parts.length === 0 ? undefined : parts;
}

/**
 * From and To must differ, and the refusal names To.
 *
 * A class-level constraint because it is the only rule here that needs two
 * fields at once. It reports against `to` deliberately: a traveller told
 * "from is invalid" would go and change the wrong one.
 */
@ValidatorConstraint({ name: 'differentStations', async: false })
class DifferentStations implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as SearchTripsDto;
    return dto.to !== dto.from;
  }

  defaultMessage(): string {
    return 'to must be a different station from from';
  }
}

/**
 * `GET /api/v1/trips/search`.
 *
 * The shape is checked here so an obviously wrong request never reaches
 * catalog. Catalog validates again -- a gRPC peer is not a trusted caller --
 * and only it can answer the questions that need the catalogue, like whether a
 * station exists and is active.
 *
 * The global pipe already applies `whitelist` and `forbidNonWhitelisted`, so an
 * unknown query parameter is a 400 without anything here saying so.
 */
export class SearchTripsDto {
  /** Station uuids, as the station list (CAT-2) hands them out. */
  @IsUUID()
  from!: string;

  @IsUUID()
  @Validate(DifferentStations)
  to!: string;

  /** A Cairo civil date. Whether it is bookable is catalog's to say. */
  @Matches(CIVIL_DATE_PATTERN, {
    message: 'departureDate must be a date in YYYY-MM-DD form',
  })
  departureDate!: string;

  /** Required: every result's seats and fare are for exactly one class. */
  @IsUUID()
  travelClassId!: string;

  /**
   * Optional narrowing (BR-18). Arabic-Indic digits are accepted and
   * normalized; `ValidateIf` keeps an absent value absent rather than letting
   * `@IsOptional` swallow a malformed one.
   */
  @ValidateIf((dto: SearchTripsDto) => dto.trainNumber !== undefined)
  @Transform(({ value }) => toAsciiDigits(value))
  @IsInt({ message: 'trainNumber must be a whole number' })
  @Min(1, { message: 'trainNumber must be 1 or greater' })
  trainNumber?: number;

  /**
   * A round trip's return date (BR-20).
   *
   * Does not change this list -- the outbound leg is the same search either
   * way. Sending it lets catalog refuse an impossible return date now rather
   * than after the traveller has chosen an outbound trip, and is what makes
   * their recent-search entry a round trip.
   */
  @ValidateIf((dto: SearchTripsDto) => dto.returnDate !== undefined)
  @Matches(CIVIL_DATE_PATTERN, {
    message: 'returnDate must be a date in YYYY-MM-DD form',
  })
  returnDate?: string;

  /**
   * The order (BR-18). Absent means departure time ascending, which is also
   * what the wire's UNSPECIFIED decodes to, so the default lives in one place.
   */
  @IsOptional()
  @IsIn(SEARCH_SORTS, {
    message: `sort must be one of: ${SEARCH_SORTS.join(', ')}`,
  })
  sort?: (typeof SEARCH_SORTS)[number];

  /**
   * Train types to keep, as CSV: `trainTypeIds=<uuid>,<uuid>`.
   *
   * A query string has no arrays, and the repeated-key form (`a=1&a=2`) gives a
   * string for one value and an array for two -- a shape that changes with the
   * data. CSV is one shape always.
   */
  @IsOptional()
  @Transform(({ value }) => csvToArray(value))
  @IsUUID('all', {
    each: true,
    message: 'trainTypeIds must be a comma-separated list of train type ids',
  })
  trainTypeIds?: string[];

  /**
   * The departure window, as Cairo wall-clock times: `departAfter=06:00`.
   *
   * Converted to minutes since midnight for the wire. The window must stay
   * inside the selected day and start before it ends -- catalog refuses a
   * wrapping window, naming the field, rather than silently searching two days.
   */
  @ValidateIf((dto: SearchTripsDto) => dto.departAfter !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ message: 'departAfter must be a time of day in HH:mm form' })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departAfter?: number;

  @ValidateIf((dto: SearchTripsDto) => dto.departBefore !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ message: 'departBefore must be a time of day in HH:mm form' })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departBefore?: number;

  /**
   * A price ceiling in piastres, compared with the fare *without* the booking
   * fee (BR-19). Arabic-Indic digits are accepted, as for the train number.
   */
  @ValidateIf((dto: SearchTripsDto) => dto.maxFare !== undefined)
  @Transform(({ value }) => toAsciiDigits(value))
  @IsInt({ message: 'maxFare must be a whole number of piastres' })
  @Min(0, { message: 'maxFare must be 0 or greater' })
  maxFare?: number;

  /**
   * Hide sold-out trips. Absent and `false` both mean "show them, marked",
   * which is BR-16's default: a full train is information, not noise.
   */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean({ message: 'excludeSoldOut must be true or false' })
  excludeSoldOut?: boolean;

  /**
   * The caller's declared preference. Absent means the platform default, and
   * `Accept-Language` is what actually decides the response language (BR-56).
   */
  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
