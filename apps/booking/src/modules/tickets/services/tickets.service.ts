import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import QRCode from 'qrcode';
import { CALLER_ACCOUNT_ID_KEY, CALLER_ROLES_KEY } from '@app/common';
import {
  ErrorCode,
  type ListTicketsRequest,
  type SharedTicket,
  type SharedTicketRequest,
  type TicketActions,
  type TicketPage,
  type TicketPdf,
  type TicketPdfRequest,
  type TicketQr,
  type TicketRequest,
  type TicketShareLink,
  type TicketStatus,
  type TicketVerification,
  type TicketVerificationResult,
  type VerificationKeys,
  type VerifyTicketRequest,
} from '@app/contracts';

import { BookingFlowError } from '../../flow/booking-flow-error.js';
import {
  decodeTicketCursor,
  encodeTicketCursor,
} from '../ticket-page-cursor.js';
import { renderTicketPdf } from '../ticket-pdf.js';
import {
  allowedActionsOf,
  isUpcoming,
  toSharedTicket,
  toTicketCard,
  type IssuedTicket,
} from '../ticket-view.js';
import { TicketsRepository } from '../tickets.repository.js';
import { TicketSignerService } from './ticket-signer.service.js';

export const DEFAULT_TICKET_PAGE_SIZE = 20;
export const MAX_TICKET_PAGE_SIZE = 50;

const PAID: readonly TicketStatus[] = ['active'];
const CANCELLED: readonly TicketStatus[] = ['cancelled', 'voided'];

/**
 * The traveller's tickets and the conductor's check.
 *
 * Ownership is decided here, not only at the gateway (BR-09): another
 * traveller's ticket is answered exactly like a ticket that does not exist.
 * Every state check reads the ticket now -- nothing is cached -- so a
 * cancellation ends its share link and fails its online check at once.
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly repository: TicketsRepository,
    private readonly signer: TicketSignerService,
    private readonly cls: ClsService,
  ) {}

  listPaid(request: ListTicketsRequest): Promise<TicketPage> {
    return this.list(PAID, request);
  }

  /** Cancelled and voided tickets; their refund status is PAY-3's. */
  listCancelled(request: ListTicketsRequest): Promise<TicketPage> {
    return this.list(CANCELLED, request);
  }

  async qr(request: TicketRequest): Promise<TicketQr> {
    const ticket = await this.permitted(request.ticketId, 'qr');
    return {
      payload: ticket.qrPayload,
      keyId: this.signer.keyIdOf(ticket.qrPayload),
      image: await QRCode.toDataURL(ticket.qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 480,
      }),
    };
  }

  async shareLink(request: TicketRequest): Promise<TicketShareLink> {
    const ticket = await this.permitted(request.ticketId, 'share');
    return {
      token: await this.signer.signShareToken(ticket.id, ticket.arrivesAt),
      expiresAt: ticket.arrivesAt.toISOString(),
    };
  }

  /**
   * Anyone holding the link, no sign-in. The token names one ticket and when
   * it expires; whether that ticket is still valid is read now, so a link to
   * a ticket cancelled a moment ago no longer works. Every failure -- altered,
   * expired, cancelled, unknown -- is the same not-found.
   */
  async shared(request: SharedTicketRequest): Promise<SharedTicket> {
    const ticketId = await this.signer.verifyShareToken(request.token);
    const ticket = ticketId ? await this.repository.findById(ticketId) : null;
    if (!ticket || !isUpcoming(ticket, new Date())) throw notFound();
    return toSharedTicket(ticket);
  }

  /** In the request's language, which is not necessarily the account's. */
  async pdf(request: TicketPdfRequest): Promise<TicketPdf> {
    const ticket = await this.permitted(request.ticketId, 'download');
    return {
      content: await renderTicketPdf(ticket, request.language),
      fileName: `ticket-${ticket.ticketNumber}.pdf`,
    };
  }

  /**
   * The conductor's online check: the signature proves the QR is ours, and
   * the ticket's current row decides whether it still stands. Always the
   * database, never a cache -- a cached "valid" could pass a ticket cancelled
   * seconds ago. A rejection is an answer for the scanner, not an error.
   */
  async verify(request: VerifyTicketRequest): Promise<TicketVerification> {
    this.requireConductor();
    const verified = await this.signer.verifyQr(request.qr);
    if (verified.status === 'malformed') return rejected('MALFORMED');
    if (verified.status === 'invalid-signature') {
      return rejected('INVALID_SIGNATURE');
    }

    const ticket = await this.repository.findByTicketNumber(
      verified.claims.ticketNumber,
    );
    if (!ticket) return rejected('UNKNOWN_TICKET');

    const card = toTicketCard(ticket, new Date());
    if (ticket.status !== 'active') {
      return {
        valid: false,
        result: ticket.status === 'cancelled' ? 'CANCELLED' : 'VOIDED',
        reason: ticket.statusReason ?? '',
        ticket: card,
      };
    }
    return { valid: true, result: 'VALID', reason: '', ticket: card };
  }

  /** Public keys only, for scanners that verify offline. */
  async verificationKeys(): Promise<VerificationKeys> {
    this.requireConductor();
    return { keys: await this.signer.verificationKeySet() };
  }

  private async list(
    statuses: readonly TicketStatus[],
    request: ListTicketsRequest,
  ): Promise<TicketPage> {
    const ownerId = this.callerId();
    const after = request.cursor ? decodeTicketCursor(request.cursor) : null;
    const asOf = after?.asOf ?? new Date();
    const limit = Math.min(
      request.limit > 0 ? request.limit : DEFAULT_TICKET_PAGE_SIZE,
      MAX_TICKET_PAGE_SIZE,
    );

    const rows = await this.repository.page({
      ownerId,
      statuses,
      asOf,
      after,
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const now = new Date();

    return {
      // The order is fixed by asOf; what may be done is always decided now.
      tickets: page.map((row) => toTicketCard(row.ticket, now)),
      nextCursor:
        rows.length > limit && last
          ? encodeTicketCursor({
              asOf,
              bucket: last.bucket,
              sortKey: last.sortKey,
              ticketId: last.ticket.id,
            })
          : '',
    };
  }

  /** The caller's own ticket, and only if the action is allowed right now. */
  private async permitted(
    ticketId: string,
    action: keyof TicketActions,
  ): Promise<IssuedTicket> {
    const ticket = await this.repository.findById(ticketId);
    if (!ticket || ticket.ownerId !== this.callerId()) throw notFound();
    if (!allowedActionsOf(ticket, new Date())[action]) {
      throw new BookingFlowError(ErrorCode.TICKET_NOT_ACTIVE);
    }
    return ticket;
  }

  private callerId(): string {
    const caller = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
    if (!caller) throw new BookingFlowError(ErrorCode.UNAUTHORIZED);
    return caller;
  }

  /** The gateway checks the role too; booking does not take it on trust. */
  private requireConductor(): void {
    const roles = this.cls.get<string[]>(CALLER_ROLES_KEY) ?? [];
    if (!this.cls.get<string>(CALLER_ACCOUNT_ID_KEY)) {
      throw new BookingFlowError(ErrorCode.UNAUTHORIZED);
    }
    if (!roles.includes('conductor')) {
      throw new BookingFlowError(ErrorCode.FORBIDDEN);
    }
  }
}

function notFound(): BookingFlowError {
  return new BookingFlowError(ErrorCode.RESOURCE_NOT_FOUND);
}

function rejected(result: TicketVerificationResult): TicketVerification {
  return { valid: false, result, reason: '' };
}
