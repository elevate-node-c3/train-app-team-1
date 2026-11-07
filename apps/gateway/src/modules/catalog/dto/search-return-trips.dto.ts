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

import {
  CIVIL_DATE_PATTERN,
  MINUTES_IN_A_DAY,
  SEARCH_SORTS,
  clockTimeToMinutes,
  csvToArray,
  toAsciiDigits,
  toBoolean,
} from './search-trips.dto.js';

/**
 * The outbound segment must be a journey, not a station twice over.
 *
 * Reported against the destination for the same reason the one-way DTO does:
 * a traveller told "from is invalid" would change the wrong one.
 */
@ValidatorConstraint({ name: 'differentOutboundStations', async: false })
class DifferentOutboundStations implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as SearchReturnTripsDto;
    return dto.outboundTo !== dto.outboundFrom;
  }

  defaultMessage(): string {
    return 'outboundTo must be a different station from outboundFrom';
  }
}

/**
 * `GET /api/v1/trips/search/return`.
 *
 * The second list of a round trip, computed from the outbound trip the
 * traveller chose. What is deliberately *not* here is any arrival time: BR-20
 * says the server reads the chosen trip's arrival itself, and a client able to
 * send one could widen the window and be offered a train it cannot catch.
 *
 * There is no train number either. It narrowed the outbound leg only -- a
 * return train has its own number.
 *
 * The filters and the order repeat the one-way DTO's shapes, because filters
 * apply to each list separately and a traveller would not accept two different
 * spellings of the same thing.
 */
export class SearchReturnTripsDto {
  /** The trip the traveller chose, from the outbound results. */
  @IsUUID()
  outboundTripId!: string;

  /**
   * The outbound journey's own two stations.
   *
   * Needed because a trip calls at many stations and the return search starts
   * where this traveller actually got off. The server still checks them
   * against the trip rather than trusting the pair.
   */
  @IsUUID()
  outboundFrom!: string;

  @IsUUID()
  @Validate(DifferentOutboundStations)
  outboundTo!: string;

  /** A Cairo civil date. BR-20's rules about it are catalog's to apply. */
  @Matches(CIVIL_DATE_PATTERN, {
    message: 'returnDate must be a date in YYYY-MM-DD form',
  })
  returnDate!: string;

  /** The same class for both legs: a round-trip search has one seat class. */
  @IsUUID()
  travelClassId!: string;

  @IsOptional()
  @IsIn(SEARCH_SORTS, {
    message: `sort must be one of: ${SEARCH_SORTS.join(', ')}`,
  })
  sort?: (typeof SEARCH_SORTS)[number];

  @IsOptional()
  @Transform(({ value }) => csvToArray(value))
  @IsUUID('all', {
    each: true,
    message: 'trainTypeIds must be a comma-separated list of train type ids',
  })
  trainTypeIds?: string[];

  @ValidateIf((dto: SearchReturnTripsDto) => dto.departAfter !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ message: 'departAfter must be a time of day in HH:mm form' })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departAfter?: number;

  @ValidateIf((dto: SearchReturnTripsDto) => dto.departBefore !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ message: 'departBefore must be a time of day in HH:mm form' })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departBefore?: number;

  @ValidateIf((dto: SearchReturnTripsDto) => dto.maxFare !== undefined)
  @Transform(({ value }) => toAsciiDigits(value))
  @IsInt({ message: 'maxFare must be a whole number of piastres' })
  @Min(0, { message: 'maxFare must be 0 or greater' })
  maxFare?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean({ message: 'excludeSoldOut must be true or false' })
  excludeSoldOut?: boolean;

  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
