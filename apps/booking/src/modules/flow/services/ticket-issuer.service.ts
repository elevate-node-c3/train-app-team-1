import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import type { BookingDraftEntity } from '../../draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../entities/ticket.entity.js';

/**
 * One ticket per passenger per leg, in the caller's transaction. The unique
 * (booking_reference, passenger_ref, trip_id) index is what makes a replay a
 * no-op instead of a second ticket.
 */
@Injectable()
export class TicketIssuerService {
  async issue(
    ctx: TransactionContext,
    draft: BookingDraftEntity,
  ): Promise<TicketEntity[]> {
    const manager = entityManagerOf(ctx);
    const passengers = draft.passengerSnapshot ?? [];
    const settledSeats = draft.settledSeats ?? [];
    const tickets: TicketEntity[] = [];

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

        await manager.query(
          `INSERT INTO ticket
             (id, booking_reference, passenger_ref, trip_id, ticket_number,
              coach_number, seat_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (booking_reference, passenger_ref, trip_id) DO NOTHING`,
          [
            ticket.id,
            ticket.bookingReference,
            ticket.passengerRef,
            ticket.tripId,
            ticket.ticketNumber,
            ticket.coachNumber,
            ticket.seatNumber,
          ],
        );

        tickets.push(ticket);
      }
    }

    return tickets;
  }
}
