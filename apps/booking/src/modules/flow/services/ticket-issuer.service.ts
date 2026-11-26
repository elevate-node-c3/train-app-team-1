import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import type { BookingDraftEntity } from '../../draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../entities/ticket.entity.js';
import { TicketSignerService } from '../../tickets/services/ticket-signer.service.js';
import {
  newBookingCode,
  qrClaimsOf,
  ticketSnapshotOf,
} from '../../tickets/ticket-snapshot.js';

/**
 * One ticket per passenger per leg, in the caller's transaction. The unique
 * (booking_reference, passenger_ref, trip_id) index is what makes a replay a
 * no-op instead of a second ticket.
 *
 * Each ticket carries its own snapshot and signed QR (TA-108), written in the
 * same INSERT, so no ticket ever exists without what it prints.
 */
@Injectable()
export class TicketIssuerService {
  constructor(private readonly signer: TicketSignerService) {}

  async issue(
    ctx: TransactionContext,
    draft: BookingDraftEntity,
  ): Promise<TicketEntity[]> {
    const manager = entityManagerOf(ctx);
    const passengers = draft.passengerSnapshot ?? [];
    const settledSeats = draft.settledSeats ?? [];
    const bookingCode = await this.bookingCodeOf(manager, draft.id);

    for (const passenger of passengers) {
      const seats = settledSeats.filter(
        (seat) => seat.passengerRef === passenger.passengerRef,
      );
      for (const seat of seats) {
        // A per-call counter starting at 1 would collide on the
        // globally-unique ticket_number the moment a second booking
        // confirms; the sequence is unique across every booking ever issued.
        const [{ n }]: { n: string }[] = await manager.query(
          `SELECT nextval('ticket_number_seq')::text AS n`,
        );
        const ticket = new TicketEntity();
        ticket.id = randomUUID();
        ticket.bookingReference = draft.id;
        ticket.passengerRef = seat.passengerRef;
        ticket.tripId = seat.tripId;
        ticket.ticketNumber = `TKT-${n}`;
        ticket.coachNumber = seat.coachNumber;
        ticket.seatNumber = seat.seatNumber;

        const snapshot = ticketSnapshotOf(draft, seat, bookingCode);
        const qr = await this.signer.signQr(
          qrClaimsOf(
            ticket.ticketNumber,
            snapshot,
            seat.coachNumber,
            seat.seatNumber,
          ),
        );

        await manager.query(
          `INSERT INTO ticket
             (id, booking_reference, passenger_ref, trip_id, ticket_number,
              coach_number, seat_number, owner_id, snapshot, departs_at,
              arrives_at, qr_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (booking_reference, passenger_ref, trip_id) DO NOTHING`,
          [
            ticket.id,
            ticket.bookingReference,
            ticket.passengerRef,
            ticket.tripId,
            ticket.ticketNumber,
            ticket.coachNumber,
            ticket.seatNumber,
            draft.userId,
            JSON.stringify(snapshot),
            snapshot.boarding.at.iso,
            snapshot.alighting.at.iso,
            qr,
          ],
        );
      }
    }

    return manager.getRepository(TicketEntity).find({
      where: { bookingReference: draft.id },
      order: { ticketNumber: 'ASC' },
    });
  }

  /**
   * One code per booking, kept on a replay. A collision with another booking's
   * code fails the unique index and the saga simply retries the step.
   */
  private async bookingCodeOf(
    manager: EntityManager,
    bookingReference: string,
  ): Promise<string> {
    const rows: { booking_code: string }[] = await manager.query(
      `UPDATE booking_draft
          SET booking_code = COALESCE(booking_code, $2)
        WHERE id = $1
        RETURNING booking_code`,
      [bookingReference, newBookingCode()],
    );
    const code = unwrap<{ booking_code: string }>(rows)[0]?.booking_code;
    if (!code) throw new Error('The booking to issue tickets for is missing');
    return code;
  }
}

/** pg returns [rows, count] for UPDATE ... RETURNING through TypeORM. */
function unwrap<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return result as T[];
}
