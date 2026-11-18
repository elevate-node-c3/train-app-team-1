import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ErrorCode, HTTP_STATUS_BY_ERROR_CODE } from '@app/contracts';
import {
  BookingDraftService,
  BookingDraftError,
} from './booking-draft.service.js';
import {
  CreateBookingDraftDto,
  type BookingDraftResponse,
} from './dto/create-booking-draft.dto.js';

@Controller('drafts')
export class BookingDraftController {
  constructor(private readonly draftService: BookingDraftService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @Body() dto: CreateBookingDraftDto,
  ): Promise<BookingDraftResponse> {
    try {
      return await this.draftService.createDraft(dto);
    } catch (error) {
      if (error instanceof BookingDraftError) {
        const status =
          HTTP_STATUS_BY_ERROR_CODE[error.code] ??
          (error.code === ErrorCode.INSUFFICIENT_SEATS ||
          error.code === ErrorCode.SEAT_ALREADY_TAKEN
            ? HttpStatus.CONFLICT
            : HttpStatus.BAD_REQUEST);

        throw new HttpException(
          {
            code: error.code,
            message: error.message,
            ...(error.availableCount !== undefined
              ? { availableCount: error.availableCount }
              : {}),
          },
          status,
        );
      }
      throw error;
    }
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getDraft(
    @Param('id') id: string,
  ): Promise<BookingDraftResponse> {
    const draft = await this.draftService.getDraft(id);
    if (!draft) {
      throw new NotFoundException({
        code: ErrorCode.RESOURCE_NOT_FOUND,
        message: `Booking draft with id '${id}' not found`,
      });
    }
    return draft;
  }
}
