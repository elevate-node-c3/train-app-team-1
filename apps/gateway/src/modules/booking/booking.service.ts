import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ErrorCode } from '@app/contracts';
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

  constructor(baseUrl = 'http://booking:3000') {
    this.normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  }

  async createDraft(
    dto: CreateBookingDto,
    userId: string,
  ): Promise<BookingDraftResponse> {
    const url = `${this.normalizedBaseUrl}/drafts`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, dto, { userId })),
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

    const payload = (await response.json()) as any;
    if (!response.ok) {
      throw new HttpException(payload, response.status);
    }
    return payload as BookingDraftResponse;
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
