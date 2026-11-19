import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  CreateHoldRequest,
  ExtendHoldRequest,
  GetHoldRequest,
  HoldLegInput,
  HoldPassengerInput,
  HoldPassengerLegIdentityInput,
  ReleaseHoldRequest,
} from '@app/contracts';

import {
  MAX_BOOKING_KEY_LENGTH,
  MAX_LEGS,
  MAX_PASSENGER_REF_LENGTH,
  MAX_PASSENGER_TOKEN_LENGTH,
  MAX_PASSENGERS,
} from '../seat-hold.limits.js';

/**
 * The shape of a hold request, and only the shape.
 *
 * Every field in inventory.proto appears here: the pipe runs with
 * forbidNonWhitelisted and the proto loader fills in defaults, so a field
 * missing from a DTO would refuse every request that carries it.
 *
 * The limits come from the same constants the service uses, and bookingKey and
 * passengerRef stay opaque text. Ids must be RFC UUIDs: the boundary is the
 * place to be strict, so nothing malformed reaches a uuid column.
 *
 * What stays in the service: one leg per trip, exactly one identity per leg
 * keyed by trip, and the same token twice. Those read across fields, and the
 * service must keep them regardless -- a direct caller never passes this pipe.
 */
export class GetHoldRequestDto implements GetHoldRequest {
  @IsUUID()
  ownerId!: string;

  /** Booking's idempotency key: opaque to inventory, so text, not a UUID. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOOKING_KEY_LENGTH)
  bookingKey!: string;
}

export class ReleaseHoldRequestDto
  extends GetHoldRequestDto
  implements ReleaseHoldRequest {}

export class ExtendHoldRequestDto
  extends GetHoldRequestDto
  implements ExtendHoldRequest {}

export class HoldLegInputDto implements HoldLegInput {
  @IsUUID()
  tripId!: string;

  @IsUUID()
  travelClassId!: string;

  @IsUUID()
  originStationId!: string;

  @IsUUID()
  destinationStationId!: string;
}

export class HoldPassengerLegIdentityInputDto
  implements HoldPassengerLegIdentityInput
{
  @IsUUID()
  tripId!: string;

  /** An identity-issued HMAC. Never echoed back on a refusal. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSENGER_TOKEN_LENGTH)
  passengerToken!: string;

  @IsInt()
  @Min(1)
  passengerKeyVersion!: number;
}

export class HoldPassengerInputDto implements HoldPassengerInput {
  /** Booking's opaque reference for the traveller, never a raw National ID. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSENGER_REF_LENGTH)
  passengerRef!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LEGS)
  @ValidateNested({ each: true })
  @Type(() => HoldPassengerLegIdentityInputDto)
  identities!: HoldPassengerLegIdentityInputDto[];
}

export class CreateHoldRequestDto
  extends GetHoldRequestDto
  implements CreateHoldRequest
{
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LEGS)
  @ArrayUnique((leg: HoldLegInputDto) => leg.tripId)
  @ValidateNested({ each: true })
  @Type(() => HoldLegInputDto)
  legs!: HoldLegInputDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PASSENGERS)
  @ArrayUnique((passenger: HoldPassengerInputDto) => passenger.passengerRef)
  @ValidateNested({ each: true })
  @Type(() => HoldPassengerInputDto)
  passengers!: HoldPassengerInputDto[];
}
