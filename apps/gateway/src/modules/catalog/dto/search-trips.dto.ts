import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { EventLanguage } from '@app/contracts';

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** '٠'..'٩' and the Persian forms, which Arabic keyboards also produce. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Turns Arabic-Indic digits into ASCII before validation.
 *
 * A traveller on an Arabic keyboard types ٨٠٣, and the rule says that is a
 * valid train number. Normalizing at the edge means catalog only ever sees
 * ASCII and needs no opinion about scripts -- which is why its own validator
 * refuses a non-number rather than trying to interpret one.
 */
function toAsciiDigits(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const ascii = value
    .trim()
    .replace(ARABIC_INDIC_DIGITS, (digit) =>
      String(
        digit.charCodeAt(0) >= 0x06f0
          ? digit.charCodeAt(0) - 0x06f0
          : digit.charCodeAt(0) - 0x0660,
      ),
    );

  // Left as the original string when it is not a number at all, so
  // class-validator reports the field rather than silently producing NaN.
  return /^\d+$/.test(ascii) ? Number(ascii) : value;
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
   * The caller's declared preference. Absent means the platform default, and
   * `Accept-Language` is what actually decides the response language (BR-56).
   */
  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
