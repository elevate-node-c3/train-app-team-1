import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  Public,
  RateLimit,
  RequireAccess,
  RequireRole,
  resolveLanguage,
} from '@app/common';
import type {
  SharedTicket,
  TicketPage,
  TicketQr,
  TicketShareLink,
  TicketVerification,
  VerificationKeys,
} from '@app/contracts';

import {
  ListTicketsQueryDto,
  SharedTicketParamDto,
  TicketIdParamDto,
  VerifyTicketDto,
} from './dto/ticket.dto.js';
import { TicketsGrpcClientService } from './tickets.grpc.client.js';

/** Where a share token is opened; the client builds its own link around it. */
export const SHARED_TICKET_PATH = '/api/v1/shared-tickets';

/**
 * The HTTP adapter for booking's tickets, and nothing else.
 *
 * Nothing is decided here. Booking owns the tickets, decides whose they are
 * (BR-09) and what may be done with each (BR-39); the gateway checks who is
 * calling and forwards. Each route declares its own access: a traveller's
 * own tickets, the one public share route, and the conductor's check.
 */
@Controller()
export class TicketsController {
  constructor(private readonly tickets: TicketsGrpcClientService) {}

  /** Upcoming first, nearest departure first; then past, newest first (BR-40). */
  @Get('tickets/paid')
  @RequireAccess('traveller')
  paid(@Query() query: ListTicketsQueryDto): Promise<TicketPage> {
    return this.tickets.listPaid({
      limit: query.limit ?? 0,
      cursor: query.cursor ?? '',
    });
  }

  /** Cancelled and voided tickets, with their refund status when PAY-3 has one. */
  @Get('tickets/cancelled')
  @RequireAccess('traveller')
  cancelled(@Query() query: ListTicketsQueryDto): Promise<TicketPage> {
    return this.tickets.listCancelled({
      limit: query.limit ?? 0,
      cursor: query.cursor ?? '',
    });
  }

  @Get('tickets/:ticketId/qr')
  @RequireAccess('traveller')
  qr(@Param() params: TicketIdParamDto): Promise<TicketQr> {
    return this.tickets.qr(params.ticketId);
  }

  @Post('tickets/:ticketId/share-link')
  @RequireAccess('traveller')
  @HttpCode(HttpStatus.CREATED)
  async shareLink(
    @Param() params: TicketIdParamDto,
  ): Promise<TicketShareLink & { path: string }> {
    const link = await this.tickets.shareLink(params.ticketId);
    return { ...link, path: `${SHARED_TICKET_PATH}/${link.token}` };
  }

  /** In the request's language: an Arabic request gets an Arabic ticket. */
  @Get('tickets/:ticketId/pdf')
  @RequireAccess('traveller')
  async pdf(
    @Param() params: TicketIdParamDto,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<StreamableFile> {
    const pdf = await this.tickets.pdf({
      ticketId: params.ticketId,
      language: resolveLanguage(acceptLanguage),
    });
    return new StreamableFile(pdf.content, {
      type: 'application/pdf',
      disposition: `attachment; filename="${pdf.fileName}"`,
      length: pdf.content.length,
    });
  }

  /**
   * BR-39's one exception to sign-in: whoever holds the link sees that one
   * ticket, read-only, until the passenger arrives or the ticket is cancelled.
   */
  @Get('shared-tickets/:token')
  @Public()
  @RateLimit({ bucket: 'shared-ticket', limit: 60, windowSeconds: 60 })
  shared(@Param() params: SharedTicketParamDto): Promise<SharedTicket> {
    return this.tickets.shared(params.token);
  }

  /** The online check: signature, then the ticket's current state (BR-01). */
  @Post('ticket-verifications')
  @RequireRole('conductor')
  @HttpCode(HttpStatus.OK)
  verify(@Body() body: VerifyTicketDto): Promise<TicketVerification> {
    return this.tickets.verify(body.qr);
  }

  /** Public keys for scanners that verify offline; never a private key. */
  @Get('ticket-verifications/keys')
  @RequireRole('conductor')
  verificationKeys(): Promise<VerificationKeys> {
    return this.tickets.verificationKeys();
  }
}
