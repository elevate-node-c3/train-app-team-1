import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ErrorCode } from '@app/contracts';
import { ClsService } from 'nestjs-cls';
import { CORRELATION_ID_KEY } from '@app/common';
import { isUUID } from 'class-validator';
import type {
  BookingDraftResponse,
  CreateBookingDto,
} from './dto/create-booking.dto.js';

export const BOOKING_CLIENT = 'BOOKING_CLIENT';

export interface BookingClient {
  createDraft(
    dto: CreateBookingDto,
    userId: string,
  ): Promise<BookingDraftResponse>;
  getDraft?(id: string): Promise<BookingDraftResponse>;
}

/**
 * Default HTTP client that communicates with the downstream booking microservice.
 */
@Injectable()
export class BookingHttpService implements BookingClient {
  private readonly normalizedBaseUrl: string;

  constructor(
    baseUrl = 'http://booking:3000',
    private readonly cls?: ClsService,
  ) {
    this.normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  }

  async createDraft(
    dto: CreateBookingDto,
    userId: string,
  ): Promise<BookingDraftResponse> {
    const url = `${this.normalizedBaseUrl}/drafts`;
    const serviceKey = process.env.GATEWAY_BOOKING_SERVICE_KEY;
    if (!serviceKey || serviceKey.length < 32) {
      throw new HttpException(
        { code: ErrorCode.SERVICE_UNAVAILABLE },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gateway-booking-key': serviceKey,
          'x-correlation-id': this.cls?.get<string>(CORRELATION_ID_KEY) ?? '',
        },
        // Never forward inline National IDs, caller-selected tokens, or owner overrides.
        body: JSON.stringify({
          userId,
          bookingKey: dto.bookingKey,
          passengerIds: dto.passengerIds,
          legs: dto.legs ?? [
            {
              tripId: dto.tripId,
              travelClassId: dto.travelClassId,
              originStationId: dto.originStationId,
              destinationStationId: dto.destinationStationId,
            },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpException(
        {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          message: 'Booking service is unreachable',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const error =
        payload.error && typeof payload.error === 'object'
          ? (payload.error as Record<string, unknown>)
          : payload;
      const code = Object.values(ErrorCode).includes(error.code as ErrorCode)
        ? error.code
        : ErrorCode.SERVICE_UNAVAILABLE;
      const detail = Array.isArray(error.details)
        ? (error.details.find((item: unknown) => {
            if (!item || typeof item !== 'object') return false;
            const value = (item as Record<string, unknown>).rejectedValue;
            if (!value || typeof value !== 'object') return false;
            const passenger = value as Record<string, unknown>;
            return (
              isUUID(passenger.passengerRef) &&
              /^\*{10}\d{4}$/.test(String(passenger.maskedNationalId))
            );
          }) as Record<string, unknown> | undefined)
        : undefined;
      const passenger = detail?.rejectedValue as
        { passengerRef: string; maskedNationalId: string } | undefined;
      throw new HttpException(
        {
          code,
          ...(code === ErrorCode.PASSENGER_OVERLAP && passenger
            ? {
                details: [
                  {
                    field: 'passengerIds',
                    rejectedValue: {
                      passengerRef: passenger.passengerRef,
                      maskedNationalId: passenger.maskedNationalId,
                    },
                    issueKey: 'ISSUE_PASSENGER_ALREADY_TRAVELLING',
                    actionKey: 'ACTION_CHANGE_PASSENGER_OR_TRIP',
                    params: { maskedNationalId: passenger.maskedNationalId },
                  },
                ],
              }
            : {}),
        },
        response.status,
      );
    }
    return (
      payload.success === true ? payload.data : payload
    ) as BookingDraftResponse;
  }
}

/**
 * Gateway service coordinating booking draft operations.
 */
@Injectable()
export class BookingService {
  constructor(
    @Optional()
    @Inject(BOOKING_CLIENT)
    private readonly client?: BookingClient,
  ) {}

  async createBooking(
    dto: CreateBookingDto,
    userId: string,
  ): Promise<BookingDraftResponse> {
    if (!this.client) {
      throw new HttpException(
        {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          message: 'Booking client not configured',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.client.createDraft(dto, userId);
  }
}
