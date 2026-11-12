import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A naive Cairo wall-clock time of day, e.g. '06:00'. */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * One planned stop, as submitted: a naive Cairo wall-clock time plus a day
 * offset, never an instant -- `effectiveFrom` and each generated service date
 * supply the date, catalog's own rule unchanged.
 */
export class PublishTimetableStopDto {
  @IsUUID()
  stationId!: string;

  @IsInt()
  @Min(0)
  position!: number;

  @IsInt()
  @Min(0)
  dayOffset!: number;

  @IsOptional()
  @Matches(CLOCK_TIME_PATTERN, {
    message: 'arrivalTime must be a time of day in HH:mm form',
  })
  arrivalTime?: string;

  @IsOptional()
  @Matches(CLOCK_TIME_PATTERN, {
    message: 'departureTime must be a time of day in HH:mm form',
  })
  departureTime?: string;
}

export class PublishTimetableCoachDto {
  @IsInt()
  @Min(0)
  position!: number;

  @IsInt()
  @Min(1)
  coachNumber!: number;

  @IsUUID()
  travelClassId!: string;

  @IsUUID()
  coachLayoutId!: string;
}

/** One fare the publish records, in integer piastres and excluding any fee. */
export class PublishTimetableFareDto {
  @IsUUID()
  travelClassId!: string;

  @IsUUID()
  originStationId!: string;

  @IsUUID()
  destinationStationId!: string;

  @IsInt()
  @Min(0)
  amountPiastres!: number;
}

/**
 * `POST /api/v1/operations/timetables`.
 *
 * Shape only. Whether the running days, the stop order or a fare are valid is
 * catalog's to decide -- it revalidates everything regardless, because a gRPC
 * peer is not a trusted caller.
 */
export class PublishTimetableDto {
  /** Echoed verbatim in a refusal; resolved to the integer train column server-side. */
  @IsString()
  trainNumber!: string;

  /** 0 = Sunday, matching `Date.getUTCDay()`. */
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  runningDays!: number[];

  /** A Cairo civil date. */
  @Matches(CIVIL_DATE_PATTERN, {
    message: 'effectiveFrom must be a date in YYYY-MM-DD form',
  })
  effectiveFrom!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PublishTimetableStopDto)
  stops!: PublishTimetableStopDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PublishTimetableCoachDto)
  coaches!: PublishTimetableCoachDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublishTimetableFareDto)
  fares!: PublishTimetableFareDto[];
}
