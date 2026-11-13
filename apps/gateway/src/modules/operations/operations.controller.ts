import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { RequireRole, requireIdempotencyKey } from '@app/common';

import { ChangeFareDto } from './dto/change-fare.dto.js';
import { ListAuditQueryDto } from './dto/list-audit.dto.js';
import { PublishTimetableDto } from './dto/publish-timetable.dto.js';
import {
  OperationsService,
  type ChangeFareResult,
  type ListAuditResult,
  type PublishTimetableResult,
} from './operations.service.js';

/** Check shape, role, and retry keys; catalog owns business rules. */
@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Post('timetables')
  @RequireRole('operator')
  @HttpCode(HttpStatus.CREATED)
  async publishTimetable(
    @Body() body: PublishTimetableDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PublishTimetableResult> {
    return this.operations.publishTimetable(
      body,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Post('fares')
  @RequireRole('operator')
  @HttpCode(HttpStatus.CREATED)
  async changeFare(
    @Body() body: ChangeFareDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ChangeFareResult> {
    return this.operations.changeFare(
      body,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Get('audit')
  @RequireRole('operator')
  async listAudit(@Query() query: ListAuditQueryDto): Promise<ListAuditResult> {
    return this.operations.listAudit(query);
  }
}
