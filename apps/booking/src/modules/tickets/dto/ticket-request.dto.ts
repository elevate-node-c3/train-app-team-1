import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  ListTicketsRequest,
  SharedTicketRequest,
  SupportedLanguage,
  TicketPdfRequest,
  TicketRequest,
  VerifyTicketRequest,
} from '@app/contracts';

import { MAX_TICKET_PAGE_SIZE } from '../services/tickets.service.js';

/** Matching booking.proto field for field; proto3 sends 0 and '' when unset. */
export class ListTicketsRequestDto implements ListTicketsRequest {
  @IsInt()
  @Min(0)
  @Max(MAX_TICKET_PAGE_SIZE)
  limit!: number;

  @IsString()
  @MaxLength(512)
  cursor!: string;
}

export class TicketRequestDto implements TicketRequest {
  @IsUUID()
  ticketId!: string;
}

export class TicketPdfRequestDto implements TicketPdfRequest {
  @IsUUID()
  ticketId!: string;

  @IsIn(['ar', 'en'])
  language!: SupportedLanguage;
}

/**
 * Only the token's size is checked here: whatever else is wrong with it is
 * the same not-found, so an altered link learns nothing.
 */
export class SharedTicketRequestDto implements SharedTicketRequest {
  @IsString()
  @MaxLength(2048)
  token!: string;
}

/** A malformed QR is a verdict for the scanner, not a validation error. */
export class VerifyTicketRequestDto implements VerifyTicketRequest {
  @IsString()
  @MaxLength(4096)
  qr!: string;
}
