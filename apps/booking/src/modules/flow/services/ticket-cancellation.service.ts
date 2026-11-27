import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import {
  ErrorCode,
  type ConfirmTicketCancellationRequest,
  type ConfirmTicketCancellationResponse,
  type PreviewTicketCancellationResponse,
} from '@app/contracts';

import { BookingFlowError, BookingFlowFault } from '../booking-flow-error.js';
import { BookingFlowRepository } from '../booking-flow.repository.js';
import { buildTicketCancelled } from '../cancellation-events.factory.js';
import { quoteCancellation } from './ticket-cancellation-policy.js';
import { TicketCancellationRepository } from './ticket-cancellation.repository.js';

/**
 * BOOK-4 (TA-109): the traveller sees a quote, then booking recomputes it and
 * cancels once. The refund decision stays here; no tier is trusted from a call.
 */
@Injectable()
export class TicketCancellationService {
  constructor(
    private readonly repository: TicketCancellationRepository,
    private readonly bookings: BookingFlowRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(
    ticketId: string,
    callerId: string,
  ): Promise<PreviewTicketCancellationResponse> {
    const ticket = await this.repository.findOwnedActiveOrCancelled(
      ticketId,
      callerId,
    );
    if (!ticket) throw new BookingFlowError(ErrorCode.RESOURCE_NOT_FOUND);
    if (ticket.status !== 'active') {
      throw new BookingFlowError(ErrorCode.TICKET_ALREADY_CANCELLED);
    }

    const quote = quoteCancellation({
      departsAt: ticket.departsAt,
      now: this.now(),
      farePiastres: ticket.snapshot.farePiastres,
      delayMinutes: 0,
      tripCancelled: false,
    });
    if (!quote.allowed) {
      return {
        allowed: false,
        tier: '',
        refundPiastres: 0,
        code: quote.code,
      };
    }
    return {
      allowed: true,
      tier: quote.tier,
      refundPiastres: quote.refundPiastres,
      code: '',
    };
  }

  async confirm(
    request: ConfirmTicketCancellationRequest,
    callerId: string,
    correlationId: string,
  ): Promise<ConfirmTicketCancellationResponse> {
    return this.unitOfWork.withTransaction(async (ctx) => {
      // Ownership first, so a replay of another traveller's key is a 404.
      const ticket = await this.repository.findOwnedActiveOrCancelled(
        request.ticketId,
        callerId,
      );
      if (!ticket) throw new BookingFlowError(ErrorCode.RESOURCE_NOT_FOUND);

      const prior = await this.repository.findByIdempotencyKey(
        request.ticketId,
        request.idempotencyKey,
      );
      if (prior) {
        return {
          status:
            prior.status === 'cancelled' ? 'CANCELLED' : 'ALREADY_CANCELLED',
          refundPiastres: prior.refundPiastres ?? 0,
        };
      }
      if (ticket.status !== 'active') {
        throw new BookingFlowError(ErrorCode.TICKET_ALREADY_CANCELLED);
      }

      const quote = quoteCancellation({
        departsAt: ticket.departsAt,
        now: this.now(),
        farePiastres: ticket.snapshot.farePiastres,
        delayMinutes: 0,
        tripCancelled: false,
      });
      if (!quote.allowed) {
        throw new BookingFlowError(ErrorCode.CANCELLATION_WINDOW_CLOSED);
      }
      if (quote.tier !== request.tier) {
        throw new BookingFlowError(ErrorCode.CANCELLATION_OUTCOME_CHANGED);
      }

      const cancelled = await this.repository.tryCancel(ctx, {
        ticketId: request.ticketId,
        ownerId: callerId,
        refundPiastres: quote.refundPiastres,
        idempotencyKey: request.idempotencyKey,
      });
      if (!cancelled) {
        // A concurrent winner committed between our replay lookup and the
        // guarded UPDATE: re-read by key so the loser still returns the
        // original response instead of a refusal.
        const prior = await this.repository.findByIdempotencyKey(
          request.ticketId,
          request.idempotencyKey,
        );
        if (prior) {
          return {
            status:
              prior.status === 'cancelled' ? 'CANCELLED' : 'ALREADY_CANCELLED',
            refundPiastres: prior.refundPiastres ?? 0,
          };
        }
        throw new BookingFlowError(ErrorCode.TICKET_ALREADY_CANCELLED);
      }

      const draft = await this.bookings.findById(ticket.bookingReference);
      if (!draft?.paymentReference) {
        throw new BookingFlowFault(
          'A cancelled ticket must carry its booking charge reference',
        );
      }

      await this.outbox.append(
        ctx,
        buildTicketCancelled({
          eventId: randomUUID(),
          correlationId,
          occurredAt: this.now(),
          payload: {
            ticketId: cancelled.id,
            bookingReference: cancelled.bookingReference,
            passengerRef: cancelled.passengerRef,
            tripId: cancelled.tripId,
            coachNumber: cancelled.coachNumber,
            seatNumber: cancelled.seatNumber,
            accountId: cancelled.ownerId,
            refundPiastres: quote.refundPiastres,
            paymentReference: draft.paymentReference,
          },
        }),
      );

      return { status: 'CANCELLED', refundPiastres: quote.refundPiastres };
    });
  }
}
