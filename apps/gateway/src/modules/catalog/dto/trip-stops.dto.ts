import { IsIn, IsOptional, IsUUID, Validate } from 'class-validator';
import type { EventLanguage } from '@app/contracts';
import {
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** Boarding and destination stations must differ. */
@ValidatorConstraint({ name: 'differentStopStations', async: false })
class DifferentStopStations implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as TripStopsQueryDto;
    return dto.to !== dto.from;
  }

  defaultMessage(): string {
    return 'to must be a different station from from';
  }
}

/** Require the passenger's boarding and destination pair, not the whole trip. */
export class TripStopsQueryDto {
  /** Boarding station. */
  @IsUUID()
  from!: string;

  /** Destination station. */
  @IsUUID()
  @Validate(DifferentStopStations, {
    context: {
      issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
      actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
    },
  })
  to!: string;

  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}

/** Validate tripId separately so UUID errors name the field. */
export class TripIdParamDto {
  @IsUUID()
  tripId!: string;
}
