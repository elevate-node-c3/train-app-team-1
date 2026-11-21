import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';

import type { BookingDraftEntity } from '../../draft/entities/booking-draft.entity.js';
import { BookingFlowRepository } from '../booking-flow.repository.js';
import {
  buildBookingConfirmed,
  buildBookingRefunded,
  buildBookingSeatsChanged,
} from '../confirmation-events.factory.js';
import { FlowGrpcClientsService } from './flow-grpc-clients.service.js';
import { TicketIssuerService } from './ticket-issuer.service.js';

/**
 * TA-107's saga: settle inventory's hold, then confirm with tickets or
 * refund the whole charge. One step per call -- the worker's lease bounds
 * the work, and a kill between steps resumes from `saga_step`.
 */
@Injectable()
export class BookingConfirmationService {
  constructor(
    private readonly repository: BookingFlowRepository,
    private readonly clients: FlowGrpcClientsService,
    private readonly ticketIssuer: TicketIssuerService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async run(id: string): Promise<void> {
    const draft = await this.repository.findById(id);
    if (!draft) return;

    switch (draft.sagaStep) {
      case 'payment_recorded':
        await this.settle(draft);
        return;
      case 'settled':
        await this.confirmOrBeginRefund(draft);
        return;
      case 'refunding':
        await this.payRefund(draft);
        return;
      default:
        return;
    }
  }

  private async settle(draft: BookingDraftEntity): Promise<void> {
    const settlement = await this.clients.settleHold({
      ownerId: draft.userId,
      bookingKey: draft.id,
    });

    await this.repository.recordSettlement(
      draft.id,
      settlement.outcome,
      settlement.assignments,
      settlement.outcome === 'REALLOCATED',
    );
  }

  private async confirmOrBeginRefund(draft: BookingDraftEntity): Promise<void> {
    if (draft.settlementOutcome === 'no_seats') {
      await this.repository.beginRefunding(draft.id);
      return;
    }
    await this.confirm(draft);
  }

  /** Tickets, the state change, and the outbox append: one transaction. */
  private async confirm(draft: BookingDraftEntity): Promise<void> {
    await this.unitOfWork.withTransaction(async (ctx) => {
      const tickets = await this.ticketIssuer.issue(ctx, draft);
      const confirmed = await this.repository.confirm(ctx, draft.id);
      if (!confirmed) return;

      const correlationId = draft.correlationId ?? draft.id;
      const occurredAt = new Date();

      await this.outbox.append(
        ctx,
        buildBookingConfirmed({
          eventId: randomUUID(),
          correlationId,
          occurredAt,
          payload: {
            bookingReference: draft.id,
            totalPiastres: draft.totalPiastres ?? 0,
            tickets: tickets.map((ticket) => ({
              ticketNumber: ticket.ticketNumber,
              passengerRef: ticket.passengerRef,
              tripId: ticket.tripId,
              coachNumber: ticket.coachNumber,
              seatNumber: ticket.seatNumber,
            })),
          },
        }),
      );

      if (draft.seatsChanged) {
        await this.outbox.append(
          ctx,
          buildBookingSeatsChanged({
            eventId: randomUUID(),
            correlationId,
            occurredAt,
            payload: {
              bookingReference: draft.id,
              seats: (draft.settledSeats ?? []).map((seat) => ({
                passengerRef: seat.passengerRef,
                tripId: seat.tripId,
                coachNumber: seat.coachNumber,
                seatNumber: seat.seatNumber,
              })),
            },
          }),
        );
      }
    });
  }

  private async payRefund(draft: BookingDraftEntity): Promise<void> {
    const result = await this.clients.refundCharge({
      bookingReference: draft.id,
      paymentReference: draft.paymentReference ?? '',
      idempotencyKey: `booking:${draft.id}:refund`,
    });

    await this.unitOfWork.withTransaction(async (ctx) => {
      const recorded = await this.repository.recordRefund(
        ctx,
        draft.id,
        result.refundReference,
      );
      if (!recorded) return;

      await this.outbox.append(
        ctx,
        buildBookingRefunded({
          eventId: randomUUID(),
          correlationId: draft.correlationId ?? draft.id,
          occurredAt: new Date(),
          payload: {
            bookingReference: draft.id,
            amountPiastres: draft.totalPiastres ?? 0,
            reasonKey: 'REASON_NO_SEATS_AFTER_LATE_PAYMENT',
          },
        }),
      );
    });
  }
}
