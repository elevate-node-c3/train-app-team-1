import { IsIn, IsOptional, IsUUID, Validate } from 'class-validator';
import type { EventLanguage } from '@app/contracts';
import {
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** Boarding and alighting have to be two different places. */
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

/**
 * The query half of `GET /api/v1/trips/:tripId/stops`.
 *
 * The pair is required rather than defaulted to the whole trip: this answers
 * "what the design's '4 Stops' opens", which is the passenger's own segment,
 * and a client that sent neither would be shown a journey it did not offer.
 */
export class TripStopsQueryDto {
  /** Where the passenger boards. */
  @IsUUID()
  from!: string;

  /** Where they alight. */
  @IsUUID()
  @Validate(DifferentStopStations)
  to!: string;

  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}

/**
 * The path half, validated separately because it is a `@Param`.
 *
 * A class rather than `ParseUUIDPipe` so the refusal reads like every other
 * one in this module -- named field, stated reason.
 */
export class TripIdParamDto {
  @IsUUID()
  tripId!: string;
}
