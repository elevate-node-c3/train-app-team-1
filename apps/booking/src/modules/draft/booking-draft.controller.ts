import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
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
import { BookingIngressGuard } from './booking-ingress.guard.js';

@Controller('drafts')
@UseGuards(BookingIngressGuard)
export class BookingDraftController {
  constructor(
    @Inject(BookingDraftService)
    private readonly draftService: BookingDraftService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @Body() dto: CreateBookingDraftDto,
    @Headers('accept-language') language?: string,
  ): Promise<BookingDraftResponse> {
    return this.translate(() => this.draftService.createDraft(dto, language));
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getDraft(
    @Param('id') id: string,
    @Query('userId') userId: string,
    @Headers('accept-language') language?: string,
  ): Promise<BookingDraftResponse> {
    return this.translate(async () => {
      const draft = await this.draftService.getDraft(id, userId, language);
      if (!draft)
        throw new NotFoundException({ code: ErrorCode.RESOURCE_NOT_FOUND });
      return draft;
    });
  }

  private async translate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof BookingDraftError)) throw error;
      throw new HttpException(
        {
          code: error.code,
          ...(error.details.length ? { details: error.details } : {}),
          ...(error.availableCount !== undefined
            ? { availableCount: error.availableCount }
            : {}),
          ...(error.code === ErrorCode.DEPENDENCY_UNAVAILABLE
            ? { retryAfterSeconds: 1 }
            : {}),
        },
        HTTP_STATUS_BY_ERROR_CODE[error.code] ??
          HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
