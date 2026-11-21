import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { RequireAccess } from '@app/common';
import type { BookingResponse } from '@app/contracts';

import { BookingService } from './booking.service.js';
import { ContinueToPaymentDto } from './dto/continue-to-payment.dto.js';
import { BookingRequestGuard } from './booking-request.guard.js';
import { BookingReferenceParamDto } from './dto/booking-reference.dto.js';
import {
  CreateBookingDto,
  NoSeatSelectionPipe,
} from './dto/create-booking.dto.js';

/**
 * The HTTP adapter for booking: a route per step and nothing else.
 *
 * Nothing is decided here. BookingRequestGuard refuses a malformed payload,
 * NoSeatSelectionPipe refuses any attempt to choose a seat or coach (BR-25,
 * D2), the DTOs refuse a bad reference, and booking itself owns the price, the
 * terms and the charge. The caller is never read from the body either --
 * booking takes it from the metadata the gateway signs onto the call.
 */
@RequireAccess('bookable')
@Controller('bookings')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  /** The server allocates the seats; a repeated key resumes one booking. */
  @Post()
  @UseGuards(BookingRequestGuard)
  @UsePipes(new NoSeatSelectionPipe())
  @HttpCode(HttpStatus.CREATED)
  submit(
    @Body() dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<BookingResponse> {
    return this.bookings.submit(dto, idempotencyKey);
  }

  @Get(':bookingReference')
  @HttpCode(HttpStatus.OK)
  review(@Param() params: BookingReferenceParamDto): Promise<BookingResponse> {
    return this.bookings.review(params.bookingReference);
  }

  /** Recorded once, with its time; no acceptance, no charge. */
  @Post(':bookingReference/terms-acceptance')
  @HttpCode(HttpStatus.OK)
  acceptTerms(
    @Param() params: BookingReferenceParamDto,
  ): Promise<BookingResponse> {
    return this.bookings.acceptTerms(params.bookingReference);
  }

  @Post(':bookingReference/payment')
  @HttpCode(HttpStatus.OK)
  continueToPayment(
    @Param() params: BookingReferenceParamDto,
    @Body() dto?: ContinueToPaymentDto,
  ): Promise<BookingResponse> {
    return this.bookings.continueToPayment({
      bookingReference: params.bookingReference,
      savedCardId: dto?.savedCardId,
    });
  }

  /** Releases the seats now rather than waiting for the hold to lapse (BR-25). */
  @Delete(':bookingReference')
  @HttpCode(HttpStatus.OK)
  abandon(@Param() params: BookingReferenceParamDto): Promise<BookingResponse> {
    return this.bookings.abandon(params.bookingReference);
  }
}
