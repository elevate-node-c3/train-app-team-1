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

/** Stations must differ; report the destination as the invalid field. */
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
 * Search from the chosen outbound trip; catalog reads its arrival time.
 * Train numbers narrow only the outbound search.
 * Each leg has its own filters and sort order.
 */
export class SearchReturnTripsDto {
  /** Chosen outbound trip. */
  @IsUUID()
  outboundTripId!: string;

  /** Passenger's outbound segment; catalog verifies both stations against the trip. */
  @IsUUID()
  outboundFrom!: string;

  @IsUUID()
  @Validate(DifferentOutboundStations, {
    context: {
      issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
      actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
    },
  })
  outboundTo!: string;

  /** Cairo date; catalog checks return-date rules. */
  @Matches(CIVIL_DATE_PATTERN, {
    context: { issueKey: 'ISSUE_CIVIL_DATE_FORMAT' },
  })
  returnDate!: string;

  /** Both legs use the same travel class. */
  @IsUUID()
  travelClassId!: string;

  @IsOptional()
  @IsIn(SEARCH_SORTS, {
    context: { issueKey: 'ISSUE_SORT_NOT_OFFERED' },
  })
  sort?: (typeof SEARCH_SORTS)[number];

  @IsOptional()
  @Transform(({ value }) => csvToArray(value))
  @IsUUID('all', {
    each: true,
    context: { issueKey: 'ISSUE_TRAIN_TYPE_LIST_MALFORMED' },
  })
  trainTypeIds?: string[];

  @ValidateIf((dto: SearchReturnTripsDto) => dto.departAfter !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ context: { issueKey: 'ISSUE_CLOCK_TIME_FORMAT' } })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departAfter?: number;

  @ValidateIf((dto: SearchReturnTripsDto) => dto.departBefore !== undefined)
  @Transform(({ value }) => clockTimeToMinutes(value))
  @IsInt({ context: { issueKey: 'ISSUE_CLOCK_TIME_FORMAT' } })
  @Min(0)
  @Max(MINUTES_IN_A_DAY - 1)
  departBefore?: number;

  @ValidateIf((dto: SearchReturnTripsDto) => dto.maxFare !== undefined)
  @Transform(({ value }) => toAsciiDigits(value))
  @IsInt({ context: { issueKey: 'ISSUE_FARE_NOT_A_NUMBER' } })
  @Min(0, { context: { issueKey: 'ISSUE_FARE_NEGATIVE' } })
  maxFare?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean({ context: { issueKey: 'ISSUE_MUST_BE_YES_OR_NO' } })
  excludeSoldOut?: boolean;

  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
