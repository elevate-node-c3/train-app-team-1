import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  Public,
  RateLimit,
  RequireRole,
  requireIdempotencyKey,
  resolveLanguage,
} from '@app/common';
import {
  type ListStationsResponse,
  type StationResponse,
} from '@app/contracts';
import { CatalogService } from './catalog.service.js';
import {
  CreateStationDto,
  StationIdParamDto,
  UpdateStationDto,
} from './dto/station-requests.dto.js';

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
