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
import { BookingFlowFault } from '../booking-flow-error.js';

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
    if (draft.flowState !== 'confirming' && draft.flowState !== 'refunding')
      return;

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
    const settlement = await this.clients.settleHold(
      {
        ownerId: draft.userId,
        bookingKey: draft.id,
      },
      draft.correlationId ?? draft.id,
    );

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
      if (!(await this.repository.lockForConfirmation(ctx, draft.id))) return;
      const passengers = draft.passengerSnapshot ?? [];
      const tripIds = draft.holdIntent?.legs.map((leg) => leg.tripId) ?? [];
      const seats = draft.settledSeats ?? [];
      const pairs = new Set(
        seats.map((seat) => `${seat.passengerRef}:${seat.tripId}`),
      );
      if (
        passengers.length === 0 ||
        tripIds.length === 0 ||
        seats.length !== passengers.length * tripIds.length ||
        pairs.size !== seats.length ||
        passengers.some((passenger) =>
          tripIds.some(
            (tripId) => !pairs.has(`${passenger.passengerRef}:${tripId}`),
          ),
        )
      ) {
        throw new BookingFlowFault(
          'Settlement does not cover every passenger and leg',
        );
      }
      const tickets = await this.ticketIssuer.issue(ctx, draft);
      if (
        tickets.length !== seats.length ||
        tickets.some(
          (ticket) =>
            !seats.some(
              (seat) =>
                seat.passengerRef === ticket.passengerRef &&
                seat.tripId === ticket.tripId &&
                seat.coachNumber === ticket.coachNumber &&
                seat.seatNumber === ticket.seatNumber,
            ),
        )
      ) {
        throw new BookingFlowFault('Tickets do not cover the settled seats');
      }
      const confirmed = await this.repository.confirm(ctx, draft.id);
      if (!confirmed)
        throw new BookingFlowFault('The confirmation guard did not hold');

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
              accountId: draft.userId,
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
    if (
      draft.chargeCancelled ||
      draft.settlementOutcome !== 'no_seats' ||
      !draft.paymentReference
    ) {
      throw new BookingFlowFault(
        'A refund requires a succeeded charge and a no-seats decision',
      );
    }
    if (draft.holdId && !draft.holdReleased) {
      const released = await this.clients.releaseHold(
        { ownerId: draft.userId, bookingKey: draft.id },
        draft.correlationId ?? draft.id,
      );
      if (released.state === 'SOLD') {
        throw new BookingFlowFault(
          'Sold seats cannot be refunded by confirmation recovery',
        );
      }
      if (!['RELEASED', 'EXPIRED', 'CANCELLED'].includes(released.state)) {
        throw new BookingFlowFault('Hold release has not been acknowledged');
      }
      await this.repository.markHoldReleased(draft.id, true);
    }
    const result = await this.clients.refundCharge(
      {
        bookingReference: draft.id,
        paymentReference: draft.paymentReference ?? '',
        idempotencyKey: `booking:${draft.id}:refund`,
      },
      draft.correlationId ?? draft.id,
    );

    if (
      !['REFUNDED', 'ALREADY_REFUNDED'].includes(result.status) ||
      !result.refundReference ||
      result.amountPiastres !== draft.totalPiastres ||
      !(result.amountPiastres > 0)
    ) {
      throw new BookingFlowFault(
        'Payment did not accept the full locked refund',
      );
    }

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
            accountId: draft.userId,
            amountPiastres: draft.totalPiastres ?? 0,
            reasonKey: 'REASON_NO_SEATS_AFTER_LATE_PAYMENT',
          },
        }),
      );
    });
  }
}
