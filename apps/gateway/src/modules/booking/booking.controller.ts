import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CALLER_ACCOUNT_ID_KEY, RequireAccess } from '@app/common';
import { isUUID } from 'class-validator';
import { ErrorCode } from '@app/contracts';
import { BookingService } from './booking.service.js';
import { BookingRequestGuard } from './booking-request.guard.js';
import {
  CreateBookingDto,
  findForbiddenSeatSelectionKey,
  NoSeatSelectionPipe,
  type BookingDraftResponse,
} from './dto/create-booking.dto.js';

@RequireAccess('bookable')
@Controller('bookings')
export class BookingController {
  constructor(
    private readonly bookingService: BookingService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Creates a new booking draft.
   * Strict validation filter rejects any client attempt to submit seat or coach
   * parameters (BR-25, D2). The server allocates all seats automatically.
   */
  @Post()
  @RequireAccess('bookable')
  @UseGuards(BookingRequestGuard)
  @UsePipes(new NoSeatSelectionPipe())
  @HttpCode(HttpStatus.CREATED)
  async createBooking(
    @Body() dto: CreateBookingDto,
    @Req() req?: any,
  ): Promise<BookingDraftResponse> {
    const rawBody = req?.body ?? dto;
    const forbiddenKey = findForbiddenSeatSelectionKey(rawBody);
    if (forbiddenKey) {
      throw new HttpException(
        {
          code: ErrorCode.INVALID_PAYLOAD,
          message: `Client-specified seat or coach selection is forbidden: '${forbiddenKey}'`,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const callerId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
    if (!callerId) {
      throw new HttpException(
        { code: ErrorCode.UNAUTHORIZED },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // The same client key and owned passenger references survive a timeout retry.
    const headerKey = req?.headers?.['idempotency-key'];
    const bookingKey = headerKey ?? dto.bookingKey;
    if (
      !isUUID(bookingKey) ||
      (headerKey && dto.bookingKey && headerKey !== dto.bookingKey)
    ) {
      throw new HttpException(
        { code: ErrorCode.VALIDATION_ERROR },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      !Array.isArray(dto.passengerIds) ||
      dto.passengerIds.length < 1 ||
      dto.passengerIds.length > 4 ||
      !dto.passengerIds.every((id) => isUUID(id)) ||
      new Set(dto.passengerIds).size !== dto.passengerIds.length
    ) {
      throw new HttpException(
        { code: ErrorCode.VALIDATION_ERROR },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.bookingService.createBooking({ ...dto, bookingKey }, callerId);
  }
}
