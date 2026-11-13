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

/** Valid minute indexes are 0..1439. */
export const MINUTES_IN_A_DAY = 24 * 60;

export const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** HH:mm, from 00:00 to 23:59. */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Arabic-Indic and Persian digits. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/** Supported wire sort values. */
export const SEARCH_SORTS = [
  'SEARCH_SORT_DEPARTURE_ASC',
  'SEARCH_SORT_DURATION_ASC',
  'SEARCH_SORT_FARE_ASC',
  'SEARCH_SORT_ARRIVAL_ASC',
] as const;

/** Normalize digits while keeping clock times as strings. */
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

/** Convert Arabic-Indic numbers; keep invalid input for field validation. */
export function toAsciiDigits(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const ascii = asciiDigitsOf(value);

  return /^\d+$/.test(ascii) ? Number(ascii) : value;
}

/** Convert clock times to minutes since midnight; keep invalid input for validation. */
export function clockTimeToMinutes(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const match = CLOCK_TIME_PATTERN.exec(asciiDigitsOf(value));
  if (match === null) return value;

  return Number(match[1]) * 60 + Number(match[2]);
}

/** Accept only "true" or "false"; keep other values for validation. */
export function toBoolean(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;

  return value;
}

/** Convert a comma-separated query value to an array. */
export function csvToArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // Empty input means no filter, not an empty result set.
  return parts.length === 0 ? undefined : parts;
}

/** Require different stations and report errors on "to". */
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
 * Validate query shape here; catalog owns business rules and rechecks inputs.
 * The global pipe rejects unknown parameters.
 */
export class SearchTripsDto {
  /** Station IDs from the station list. */
  @IsUUID()
  from!: string;

  @IsUUID()
  @Validate(DifferentStations, {
    context: {
      issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
      actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
    },
  })
  to!: string;

  /** Cairo date; catalog checks whether it is bookable. */
  @Matches(CIVIL_DATE_PATTERN, {
    context: { issueKey: 'ISSUE_CIVIL_DATE_FORMAT' },
  })
  departureDate!: string;

  /** Seats and fares use this one required travel class. */
  @IsUUID()
  travelClassId!: string;

  /** Accept Arabic-Indic digits; skip only missing values, not invalid ones. */
  @ValidateIf((dto: SearchTripsDto) => dto.trainNumber !== undefined)
  @Transform(({ value }) => toAsciiDigits(value))
  @IsInt({ context: { issueKey: 'ISSUE_TRAIN_NUMBER_NOT_A_NUMBER' } })
  @Min(1, { context: { issueKey: 'ISSUE_TRAIN_NUMBER_TOO_SMALL' } })
  trainNumber?: number;

  /**
   * Catalog checks the return date and records a round trip.
   * Outbound results stay unchanged.
   */
  @ValidateIf((dto: SearchTripsDto) => dto.returnDate !== undefined)
  @Matches(CIVIL_DATE_PATTERN, {
    context: { issueKey: 'ISSUE_CIVIL_DATE_FORMAT' },
  })
  returnDate?: string;

  /** Defaults to departure time ascending. */
  @IsOptional()
  @IsIn(SEARCH_SORTS, {
    context: { issueKey: 'ISSUE_SORT_NOT_OFFERED' },
  })
  sort?: (typeof SEARCH_SORTS)[number];

  /** Train type IDs as CSV: trainTypeIds=<uuid>,<uuid>. */
  @IsOptional()
  @Transform(({ value }) => csvToArray(value))
  @IsUUID('all', {
    each: true,
    context: { issueKey: 'ISSUE_TRAIN_TYPE_LIST_MALFORMED' },
  })
  trainTypeIds?: string[];

  /**
   * Cairo times, converted to minutes since midnight.
   * Catalog requires an ordered window within one day.
   */
  @ValidateIf((dto: SearchTripsDto) => dto.departAfter !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ context: { issueKey: 'ISSUE_CLOCK_TIME_FORMAT' } })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departAfter?: number;

  @ValidateIf((dto: SearchTripsDto) => dto.departBefore !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ context: { issueKey: 'ISSUE_CLOCK_TIME_FORMAT' } })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departBefore?: number;

  /** Maximum fare in piastres, excluding fees; Arabic-Indic digits are accepted. */
  @ValidateIf((dto: SearchTripsDto) => dto.maxFare !== undefined)
  @Transform(({ value }) => toAsciiDigits(value))
  @IsInt({ context: { issueKey: 'ISSUE_FARE_NOT_A_NUMBER' } })
  @Min(0, { context: { issueKey: 'ISSUE_FARE_NEGATIVE' } })
  maxFare?: number;

  /** Missing or false keeps sold-out trips in the results. */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean({ context: { issueKey: 'ISSUE_MUST_BE_YES_OR_NO' } })
  excludeSoldOut?: boolean;

  /** Optional preference; Accept-Language controls the response language. */
  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
