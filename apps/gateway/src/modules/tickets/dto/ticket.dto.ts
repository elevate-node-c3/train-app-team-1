import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Booking's own ceiling; asking for more is refused here, not silently cut. */
const MAX_TICKET_PAGE_SIZE = 50;

/** Convert the query limit to a wire integer. */
function toInteger(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export class ListTicketsQueryDto {
  @IsOptional()
  @Transform(({ value }) => toInteger(value))
  @IsInt({ context: { issueKey: 'ISSUE_MUST_BE_WHOLE_NUMBER' } })
  @Min(1)
  @Max(MAX_TICKET_PAGE_SIZE)
  limit?: number;

  /** `nextCursor` from the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class TicketIdParamDto {
  @IsUUID()
  ticketId!: string;
}

/**
 * Only the token's size is checked here; booking answers every other problem
 * with the same not-found, so an altered link learns nothing.
 */
export class SharedTicketParamDto {
  @IsString()
  @MaxLength(2048)
  token!: string;
}

/** The scanned QR, verbatim; a malformed one is booking's verdict to give. */
export class VerifyTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  qr!: string;
}
