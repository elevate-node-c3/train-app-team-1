import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/** A cursor is an audit entry's own id. */
const MAX_CURSOR_LENGTH = 64;

/**
 * The audit filter, which had nothing checking it.
 *
 * `from` and `to` went straight into `new Date()`, so a value that is not a
 * date became an Invalid Date and reached the query as one. A page size was
 * clamped but never refused.
 */
export class ListAuditEntriesRequestDto {
  @IsUUID()
  @IsOptional()
  trainId?: string;

  @IsISO8601()
  @IsOptional()
  from?: string;

  @IsISO8601()
  @IsOptional()
  to?: string;

  /** The controller clamps the upper bound; zero and below are nonsense. */
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number;

  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  @IsOptional()
  cursor?: string;
}
