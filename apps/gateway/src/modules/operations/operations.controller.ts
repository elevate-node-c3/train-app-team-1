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

/**
 * "Safe to retry" is a rule, not an optional capability. Catalog refuses a
 * missing key too; catching it here keeps a malformed change off the wire.
 */
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
          issue: 'is required for an operator change',
          action: 'Send an Idempotency-Key header unique to this request',
        },
      ],
    },
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * The operator-only edge (TA-20). Catalog owns every validity rule; this
 * surface checks shape, role and the idempotency header, then makes the hop.
 */
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
  async listAudit(
    @Query() query: ListAuditQueryDto,
  ): Promise<ListAuditResult> {
    return this.operations.listAudit(query);
  }
}
