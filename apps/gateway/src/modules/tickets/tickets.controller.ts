import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  Public,
  RateLimit,
  requireIdempotencyKey,
  RequireAccess,
  RequireRole,
  resolveLanguage,
} from '@app/common';
import {
  ErrorCode,
  type ConfirmTicketCancellationResponse,
  type PreviewTicketCancellationResponse,
  type SharedTicket,
  type TicketPage,
  type TicketQr,
  type TicketShareLink,
  type TicketVerification,
  type VerificationKeys,
} from '@app/contracts';

import { ConfirmTicketCancellationDto } from './dto/ticket-cancellation.dto.js';
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

  /** The quote booking will recompute when the traveller confirms. */
  @Get('tickets/:ticketId/cancellation-preview')
  @RequireAccess('traveller')
  cancellationPreview(
    @Param() params: TicketIdParamDto,
  ): Promise<PreviewTicketCancellationResponse> {
    return this.tickets.previewCancellation(params.ticketId);
  }

  @Post('tickets/:ticketId/cancellation')
  @RequireAccess('traveller')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param() params: TicketIdParamDto,
    @Body() body: ConfirmTicketCancellationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ConfirmTicketCancellationResponse> {
    requireIdempotencyKey(idempotencyKey);

    try {
      return await this.tickets.confirmCancellation({
        ticketId: params.ticketId,
        tier: body.tier,
        idempotencyKey: `ticket:${params.ticketId}:cancel`,
      });
    } catch (error: unknown) {
      if (
        error instanceof HttpException &&
        (error.getResponse() as { code?: unknown })?.code ===
          ErrorCode.CANCELLATION_OUTCOME_CHANGED
      ) {
        // The quote moved: send the new one with the refusal (BR-43).
        const preview = await this.tickets.previewCancellation(params.ticketId);
        throw new HttpException(
          {
            code: ErrorCode.CANCELLATION_OUTCOME_CHANGED,
            preview,
          },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
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
