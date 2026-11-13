import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Public, RateLimit, RequireRole, resolveLanguage } from '@app/common';
import {
  ErrorCode,
  type ListStationsResponse,
  type StationResponse,
} from '@app/contracts';
import { CatalogService } from './catalog.service.js';
import {
  CreateStationDto,
  StationIdParamDto,
  UpdateStationDto,
} from './dto/station-requests.dto.js';

function requireIdempotencyKey(value: string | undefined): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key) return key;

  throw new HttpException(
    {
      code: ErrorCode.VALIDATION_ERROR,
      message: [
        {
          field: 'Idempotency-Key',
          rejectedValue: value,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED',
          actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY',
        },
      ],
    },
    HttpStatus.BAD_REQUEST,
  );
}

@Controller('stations')
export class StationsController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @RateLimit({ bucket: 'stations', limit: 60, windowSeconds: 60 })
  @Get()
  list(
    @Headers('accept-language') acceptLanguage?: string,
    @Query('query') query?: unknown,
  ): Promise<ListStationsResponse> {
    return this.catalog.listStations({
      language: resolveLanguage(acceptLanguage),
      query: typeof query === 'string' ? query : '',
    });
  }

  @Get(':id')
  @RequireRole('operator')
  getStation(@Param() params: StationIdParamDto): Promise<StationResponse> {
    return this.catalog.getStation(params.id);
  }

  @Post()
  @RequireRole('operator')
  @HttpCode(HttpStatus.CREATED)
  async createStation(
    @Body() body: CreateStationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StationResponse> {
    return this.catalog.createStation(
      body,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Patch(':id')
  @RequireRole('operator')
  async updateStation(
    @Param() params: StationIdParamDto,
    @Body() body: UpdateStationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StationResponse> {
    return this.catalog.updateStation(
      params.id,
      body,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Post(':id/deactivate')
  @RequireRole('operator')
  @HttpCode(HttpStatus.OK)
  async deactivateStation(
    @Param() params: StationIdParamDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StationResponse> {
    return this.catalog.deactivateStation(
      params.id,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Delete(':id')
  @RequireRole('operator')
  async deleteStation(
    @Param() params: StationIdParamDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StationResponse> {
    return this.catalog.deactivateStation(
      params.id,
      requireIdempotencyKey(idempotencyKey),
    );
  }
}
