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

/** Convert the query limit to a wire integer. */
function toInteger(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** No trainId means all trains; date bounds include both endpoints. */
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

  /** Last entry ID from the previous page. */
  @IsOptional()
  @IsString()
  cursor?: string;
}
