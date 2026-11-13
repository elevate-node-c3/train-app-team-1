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

/** Cairo local clock time, such as 06:00. */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Cairo clock time with a day offset, not an absolute timestamp. */
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
    context: { issueKey: 'ISSUE_CLOCK_TIME_FORMAT' },
  })
  arrivalTime?: string;

  @IsOptional()
  @Matches(CLOCK_TIME_PATTERN, {
    context: { issueKey: 'ISSUE_CLOCK_TIME_FORMAT' },
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

/** Fare in whole piastres, excluding fees. */
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

/** Check request shape; catalog also validates untrusted RPC input. */
export class PublishTimetableDto {
  /** Return the submitted train ID in errors; catalog resolves the numeric ID. */
  @IsString()
  trainNumber!: string;

  /** Sunday is 0, matching Date.getUTCDay(). */
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  runningDays!: number[];

  /** Cairo local date. */
  @Matches(CIVIL_DATE_PATTERN, {
    context: { issueKey: 'ISSUE_CIVIL_DATE_FORMAT' },
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
