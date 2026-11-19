import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import type {
  BookingLeg,
  SupportedLanguage,
  GetTripStopsRequest,
  QuoteBookingRequest,
} from '@app/contracts';

/** A quote covers an outbound leg, or an outbound and a return. */
const MAX_QUOTE_LEGS = 2;

/** The contract's own union: a resolved preference, or nothing. */
const LANGUAGES: readonly (SupportedLanguage | '')[] = ['ar', 'en', ''];

/**
 * The stops of one trip for one passenger's journey.
 *
 * TripStopsService refuses a trip that does not serve the pair, but nothing
 * checked the ids first, so a malformed one reached a uuid column and came
 * back as a masked INTERNAL rather than an answer.
 */
export class GetTripStopsRequestDto implements GetTripStopsRequest {
  @IsUUID()
  tripId!: string;

  @IsUUID()
  originStationId!: string;

  @IsUUID()
  destinationStationId!: string;

  /**
   * Carried, never used to choose a name. proto3 sends '' when a client omits
   * it, which the contract's union allows.
   */
  @IsIn(LANGUAGES)
  @IsOptional()
  language?: SupportedLanguage | '';
}

export class QuoteBookingLegDto implements BookingLeg {
  @IsUUID()
  tripId!: string;

  @IsUUID()
  originStationId!: string;

  @IsUUID()
  destinationStationId!: string;
}

/**
 * What booking asks for when it locks a price (BR-30). BookingQuoteService
 * keeps the rules that need the trips themselves -- a closed sale, a fare that
 * is missing for the class.
 */
export class QuoteBookingRequestDto implements QuoteBookingRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_QUOTE_LEGS)
  @ValidateNested({ each: true })
  @Type(() => QuoteBookingLegDto)
  legs!: QuoteBookingLegDto[];

  @IsUUID()
  travelClassId!: string;
}
