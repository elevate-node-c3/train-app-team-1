import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { RequireRole } from '@app/common';
import { ErrorCode } from '@app/contracts';

import { ChangeFareDto } from './dto/change-fare.dto.js';
import { ListAuditQueryDto } from './dto/list-audit.dto.js';
import { PublishTimetableDto } from './dto/publish-timetable.dto.js';
import {
  OperationsService,
  type ChangeFareResult,
  type ListAuditResult,
  type PublishTimetableResult,
} from './operations.service.js';

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Safe retries need an Idempotency-Key header; reject missing keys here. */
function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (key) return key;

  throw new HttpException(
    {
      code: ErrorCode.VALIDATION_ERROR,
      message: [
        {
          field: IDEMPOTENCY_KEY_HEADER,
          rejectedValue: value,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED',
          actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY',
        },
      ],
    },
    HttpStatus.BAD_REQUEST,
  );
}

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
