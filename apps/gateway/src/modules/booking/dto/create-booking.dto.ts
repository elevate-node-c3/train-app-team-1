import {
  type ArgumentMetadata,
  HttpException,
  HttpStatus,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  AllocationOutcome,
  ErrorCode,
  type SplitNoticePayload,
} from '@app/contracts';

export const FORBIDDEN_SEAT_KEYS = new Set([
  'seatId',
  'coachNumber',
  'seatNumber',
  'coach',
  'coachId',
  'seat_id',
  'coach_number',
  'seat_number',
  'coach_id',
  'seat',
  'seats',
]);

/**
 * Recursively scans any payload object or array to ensure clients do not
 * attempt to specify seat or coach parameters (BR-25, D2).
 */
export function findForbiddenSeatSelectionKey(obj: unknown): string | null {
  if (obj === null || typeof obj !== 'object') {
    return null;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findForbiddenSeatSelectionKey(item);
      if (found) return found;
    }
    return null;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_SEAT_KEYS.has(key)) {
      return key;
    }
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      normalized === 'seatid' ||
      normalized === 'coachnumber' ||
      normalized === 'seatnumber' ||
      normalized === 'coachid' ||
      normalized === 'coach'
    ) {
      return key;
    }
    const found = findForbiddenSeatSelectionKey(value);
    if (found) return found;
  }

  return null;
}

/**
 * Pipe that intercepts request body and throws HTTP 400 INVALID_PAYLOAD if
 * client specifies any seat or coach parameters.
 */
@Injectable()
export class NoSeatSelectionPipe implements PipeTransform {
  transform(value: unknown, metadata?: ArgumentMetadata) {
    if (!metadata || metadata.type === 'body') {
      const forbiddenKey = findForbiddenSeatSelectionKey(value);
      if (forbiddenKey) {
        throw new HttpException(
          {
            code: ErrorCode.INVALID_PAYLOAD,
            message: `Client-specified seat or coach selection is forbidden: '${forbiddenKey}'`,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return value;
  }
}

export class BookingLegDto {
  @IsString()
  tripId!: string;

  @IsString()
  travelClassId!: string;

  @IsString()
  originStationId!: string;

  @IsString()
  destinationStationId!: string;
}

export class CreateBookingDto {
  @IsOptional()
  @IsUUID()
  bookingKey?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  passengerIds!: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookingLegDto)
  legs?: BookingLegDto[];

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
}

export interface BookingDraftLegResponse {
  holdId: string;
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  allocationOutcome: AllocationOutcome;
  seats: string[];
  assignedSeats?: any[];
  splitNotice?: SplitNoticePayload;
  expiresAt: string;
}

export interface BookingDraftResponse {
  id: string;
  userId: string;
  status: string;
  expiresAt: string | Date | null;
  legs: BookingDraftLegResponse[];
  createdAt: string | Date;
  holdId?: string | null;
  holdState?: string | null;
  holdVersion?: number;
  serverNow?: string | Date | null;
  extensionUsed?: boolean;
  reconciliationPending?: boolean;
}
