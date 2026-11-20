import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type BookingLeg,
  type BookingResponse,
  type SubmitBookingRequest,
} from '@app/contracts';

import { BookingGrpcClientService } from './booking.grpc.client.js';
import type { CreateBookingDto } from './dto/create-booking.dto.js';

/**
 * The gateway's booking work: shape a submission for booking's checkout, and
 * name every later step by its reference.
 *
 * BookingRequestGuard has already refused anything malformed -- unknown keys,
 * a non-UUID, more than four passengers, more than two legs, a leg that starts
 * and ends at one station -- so nothing is re-checked here. What is left is the
 * one thing the guard cannot do: turn the request's two accepted shapes into
 * the single shape booking's contract takes.
 */
@Injectable()
export class BookingService {
  constructor(private readonly bookings: BookingGrpcClientService) {}

  submit(dto: CreateBookingDto, headerKey?: string): Promise<BookingResponse> {
    return this.bookings.submit(submissionOf(dto, headerKey));
  }

  review(bookingReference: string): Promise<BookingResponse> {
    return this.bookings.get({ bookingReference });
  }

  acceptTerms(bookingReference: string): Promise<BookingResponse> {
    return this.bookings.acceptTerms({ bookingReference });
  }

  continueToPayment(bookingReference: string): Promise<BookingResponse> {
    return this.bookings.continueToPayment({ bookingReference });
  }

  abandon(bookingReference: string): Promise<BookingResponse> {
    return this.bookings.abandon({ bookingReference });
  }
}

/**
 * A booking may arrive as a `legs` array or as one leg's fields at the top
 * level, and carries its class per leg. Checkout prices one class for the
 * whole booking, so two legs must agree on it.
 *
 * The owner is never read from the body: booking takes the caller from the
 * metadata the gateway signs onto the call.
 */
function submissionOf(
  dto: CreateBookingDto,
  headerKey?: string,
): SubmitBookingRequest {
  const legs = dto.legs ?? [
    {
      tripId: dto.tripId,
      travelClassId: dto.travelClassId,
      originStationId: dto.originStationId,
      destinationStationId: dto.destinationStationId,
    },
  ];

  const travelClassId = legs[0]?.travelClassId;
  if (!travelClassId || legs.some((leg) => leg.travelClassId !== travelClassId)) {
    throw new HttpException(
      {
        code: ErrorCode.VALIDATION_ERROR,
        message: [
          {
            field: 'travelClassId',
            rejectedValue: undefined,
            issueKey: 'ISSUE_VALIDATION_FAILED',
            actionKey: 'ACTION_PICK_SEAT_CLASS',
          },
        ],
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  return {
    // The guard has already made the header and the body key agree.
    idempotencyKey: (headerKey ?? dto.bookingKey) as string,
    travelClassId,
    passengerIds: dto.passengerIds,
    legs: legs.map(
      (leg): BookingLeg => ({
        tripId: leg.tripId as string,
        originStationId: leg.originStationId as string,
        destinationStationId: leg.destinationStationId as string,
      }),
    ),
  };
}
