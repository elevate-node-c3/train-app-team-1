import { Transform } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

const MAX_AUDIT_LIST_LIMIT = 200;

/** `limit` arrives as text; the wire wants an integer. */
function toInteger(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** A missing `trainId` reads every train; `from`/`to` bound `occurredAt` inclusively. */
export class ListAuditQueryDto {
  @IsOptional()
  @IsUUID()
  trainId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => toInteger(value))
  @IsInt({ context: { issueKey: 'ISSUE_MUST_BE_WHOLE_NUMBER' } })
  @Min(1)
  @Max(MAX_AUDIT_LIST_LIMIT)
  limit?: number;

  /** The `id` of the last entry a previous page returned. */
  @IsOptional()
  @IsString()
  cursor?: string;
}
