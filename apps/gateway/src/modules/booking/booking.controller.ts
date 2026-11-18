import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CALLER_ACCOUNT_ID_KEY, RequireAccess } from '@app/common';
import { ErrorCode } from '@app/contracts';
import { BookingService } from './booking.service.js';
import {
  CreateBookingDto,
  findForbiddenSeatSelectionKey,
  NoSeatSelectionPipe,
  type BookingDraftResponse,
} from './dto/create-booking.dto.js';

@RequireAccess('traveller')
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
  @RequireAccess('traveller')
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
    const userId = callerId || dto.userId || 'anonymous-traveller';

    return this.bookingService.createBooking(dto, userId);
  }
}
