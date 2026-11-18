import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { BookingDraftLeg, BookingDraftStatus } from '../entities/booking-draft.entity.js';

export class BookingPassengerInput {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  nationalId?: string;

  @IsOptional()
  @IsString()
  profileType?: string;
}

export class BookingDraftLegInput {
  @IsString()
  tripId!: string;

  @IsString()
  travelClassId!: string;

  @IsString()
  originStationId!: string;

  @IsString()
  destinationStationId!: string;
}

export class CreateBookingDraftDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookingDraftLegInput)
  legs?: BookingDraftLegInput[];

  // Direct leg fields when not nested in legs array
  @IsOptional()
  @IsString()
  tripId?: string;

  @IsOptional()
  @IsString()
  travelClassId?: string;

  @IsOptional()
  @IsString()
  originStationId?: string;

  @IsOptional()
  @IsString()
  destinationStationId?: string;

  @IsOptional()
  @IsArray()
  passengers?: BookingPassengerInput[] | string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  passengerCount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  groupSize?: number;
}

export interface BookingDraftResponse {
  id: string;
  userId: string;
  status: BookingDraftStatus;
  expiresAt: Date | string;
  legs: BookingDraftLeg[];
  createdAt: Date | string;
}
