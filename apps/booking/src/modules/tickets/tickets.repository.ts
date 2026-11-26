import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { TicketStatus } from '@app/contracts';

import { TicketEntity } from '../flow/entities/ticket.entity.js';
import type { TicketPageCursor } from './ticket-page-cursor.js';
import { isIssued, type IssuedTicket } from './ticket-view.js';

/**
 * Every read of the ticket table. Reads only: issuing belongs to the
 * confirmation saga, and cancelling to BOOK-4.
 *
 * Nothing here is cached. The online check and the share link must see a
 * cancellation the moment it commits.
 */
@Injectable()
export class TicketsRepository {
  constructor(
    @InjectRepository(TicketEntity)
    private readonly tickets: Repository<TicketEntity>,
  ) {}

  async findById(id: string): Promise<IssuedTicket | null> {
    const ticket = await this.tickets.findOne({ where: { id } });
    return isIssued(ticket) ? ticket : null;
  }

  async findByTicketNumber(ticketNumber: string): Promise<IssuedTicket | null> {
    const ticket = await this.tickets.findOne({ where: { ticketNumber } });
    return isIssued(ticket) ? ticket : null;
  }

  /**
   * One page of an owner's tickets in BR-40's order, in one statement: the
   * page is cut by the database, and every field a card shows is on the row,
   * so the round trips never grow with the number of tickets.
   *
   * Returns up to `limit + 1` rows; the extra one only says a next page exists.
   */
  async page(input: {
    ownerId: string;
    statuses: readonly TicketStatus[];
    asOf: Date;
    after: TicketPageCursor | null;
    limit: number;
  }): Promise<{ ticket: IssuedTicket; bucket: number; sortKey: string }[]> {
    const rows: TicketPageRow[] = await this.tickets.query(
      `SELECT t.*, k.bucket, k.sort_key::text AS sort_key
         FROM ticket t
        CROSS JOIN LATERAL (
          SELECT CASE WHEN t.arrives_at > $2 THEN 0 ELSE 1 END AS bucket,
                 CASE WHEN t.arrives_at > $2
                      THEN extract(epoch FROM t.departs_at)
                      ELSE -extract(epoch FROM t.departs_at) END AS sort_key
        ) k
        WHERE t.owner_id = $1
          AND t.snapshot IS NOT NULL
          AND t.status = ANY($3::text[])
          AND ($4::int IS NULL
               OR (k.bucket, k.sort_key, t.id) > ($4::int, $5::numeric, $6::uuid))
        ORDER BY k.bucket, k.sort_key, t.id
        LIMIT $7`,
      [
        input.ownerId,
        input.asOf,
        input.statuses,
        input.after?.bucket ?? null,
        input.after?.sortKey ?? null,
        input.after?.ticketId ?? null,
        input.limit + 1,
      ],
    );

    return rows.flatMap((row) => {
      const ticket = ticketOf(row);
      return isIssued(ticket)
        ? [{ ticket, bucket: Number(row.bucket), sortKey: row.sort_key }]
        : [];
    });
  }
}

type TicketPageRow = {
  id: string;
  booking_reference: string;
  passenger_ref: string;
  trip_id: string;
  ticket_number: string;
  coach_number: number;
  seat_number: string;
  created_at: Date;
  owner_id: string | null;
  snapshot: TicketEntity['snapshot'];
  departs_at: Date | null;
  arrives_at: Date | null;
  qr_payload: string | null;
  status: TicketStatus;
  status_reason: string | null;
  status_changed_at: Date | null;
  bucket: number;
  sort_key: string;
};

function ticketOf(row: TicketPageRow): TicketEntity {
  return Object.assign(new TicketEntity(), {
    id: row.id,
    bookingReference: row.booking_reference,
    passengerRef: row.passenger_ref,
    tripId: row.trip_id,
    ticketNumber: row.ticket_number,
    coachNumber: Number(row.coach_number),
    seatNumber: row.seat_number,
    createdAt: row.created_at,
    ownerId: row.owner_id,
    snapshot: row.snapshot,
    departsAt: row.departs_at,
    arrivesAt: row.arrives_at,
    qrPayload: row.qr_payload,
    status: row.status,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
  });
}
