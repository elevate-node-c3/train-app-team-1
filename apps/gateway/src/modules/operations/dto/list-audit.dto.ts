import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

const MAX_AUDIT_LIST_LIMIT = 200;

/** A query string carries `limit` as text; the wire wants an integer. */
function toInteger(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/**
 * The query half of `GET /api/v1/operations/audit`.
 *
 * A missing `trainId` reads every train; `from`/`to` bound `occurredAt`,
 * inclusive -- the same reading catalog itself applies, checked again there.
 */
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
  @IsInt({ message: 'limit must be a whole number' })
  @Min(1)
  @Max(MAX_AUDIT_LIST_LIMIT)
  limit?: number;

  /** The `id` of the last entry a previous page returned. */
  @IsOptional()
  @IsString()
  cursor?: string;
}
