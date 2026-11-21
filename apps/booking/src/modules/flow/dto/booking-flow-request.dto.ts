import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type {
  BookingLeg,
  ContinueBookingRequest,
  ContinueToPaymentRequest,
  SubmitBookingRequest,
} from '@app/contracts';

import { MAX_LEGS } from '../booking-flow.validator.js';

/** booking_draft.idempotency_key is text; the gateway sends a UUID. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export class BookingLegInputDto implements BookingLeg {
  @IsUUID()
  tripId!: string;

  @IsUUID()
  originStationId!: string;

  @IsUUID()
  destinationStationId!: string;
}

/**
 * The shape of a submission, matching booking.proto field for field.
 *
 * Deliberately silent about how many passengers a booking may carry, and
 * whether they repeat. booking-flow.validator.ts answers those with
 * PASSENGERS_REQUIRED, TOO_MANY_PASSENGERS and DUPLICATE_PASSENGER, which a
 * client acts on differently; a rule here would fire first and flatten all
 * three into VALIDATION_ERROR.
 */
export class SubmitBookingRequestDto implements SubmitBookingRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_IDEMPOTENCY_KEY_LENGTH)
  idempotencyKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LEGS)
  @ValidateNested({ each: true })
  @Type(() => BookingLegInputDto)
  legs!: BookingLegInputDto[];

  @IsUUID()
  travelClassId!: string;

  /** References only (BR-09): booking reads the passengers from identity. */
  @IsArray()
  @IsUUID(undefined, { each: true })
  passengerIds!: string[];
}

export class ContinueBookingRequestDto implements ContinueBookingRequest {
  @IsUUID()
  bookingReference!: string;
}

export class ContinueToPaymentRequestDto implements ContinueToPaymentRequest {
  @IsUUID()
  bookingReference!: string;

  @IsOptional()
  @IsUUID()
  savedCardId?: string;
}
