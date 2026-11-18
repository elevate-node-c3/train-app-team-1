import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import type { HoldState } from '@app/contracts';
import type {
  BookingDraftLeg,
  BookingDraftStatus,
} from '../entities/booking-draft.entity.js';

export class BookingDraftLegInput {
  @IsUUID()
  tripId!: string;

  @IsUUID()
  travelClassId!: string;

  @IsUUID()
  originStationId!: string;

  @IsUUID()
  destinationStationId!: string;
}

export class CreateBookingDraftDto {
  @IsUUID()
  bookingKey!: string;

  // Supplied only by the authenticated Gateway over the private ingress.
  @IsUUID()
  userId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  passengerIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => BookingDraftLegInput)
  legs?: BookingDraftLegInput[];

  // Direct leg fields when not nested in legs array
  @IsOptional()
  @IsUUID()
  tripId?: string;

  @IsOptional()
  @IsUUID()
  travelClassId?: string;

  @IsOptional()
  @IsUUID()
  originStationId?: string;

  @IsOptional()
  @IsUUID()
  destinationStationId?: string;
}

export interface BookingDraftResponse {
  id: string;
  userId: string;
  status: BookingDraftStatus;
  expiresAt: Date | string | null;
  legs: BookingDraftLeg[];
  createdAt: Date | string;
  holdId?: string | null;
  holdState?: HoldState | null;
  holdVersion?: number;
  serverNow?: Date | string | null;
  extensionUsed?: boolean;
  reconciliationPending?: boolean;
}
