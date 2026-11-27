import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';

import { TicketEntity } from '../flow/entities/ticket.entity.js';
import { issuedTicket } from './testing/ticket-fixtures.js';
import { TicketsRepository } from './tickets.repository.js';

describe('TicketsRepository.page', () => {
  it('carries the cancellation columns from the row onto the ticket', async () => {
    const ticket = issuedTicket({
      refundStatus: 'pending',
      refundPiastres: 7750,
    });
    const row = {
      id: ticket.id,
      booking_reference: ticket.bookingReference,
      passenger_ref: ticket.passengerRef,
      trip_id: ticket.tripId,
      ticket_number: ticket.ticketNumber,
      coach_number: ticket.coachNumber,
      seat_number: ticket.seatNumber,
      created_at: ticket.createdAt,
      owner_id: ticket.ownerId,
      snapshot: ticket.snapshot,
      departs_at: ticket.departsAt,
      arrives_at: ticket.arrivesAt,
      qr_payload: ticket.qrPayload,
      status: ticket.status,
      status_reason: ticket.statusReason,
      status_changed_at: ticket.statusChangedAt,
      refund_status: ticket.refundStatus,
      refund_piastres: ticket.refundPiastres,
      bucket: 0,
      sort_key: '1',
    };
    const query = vi.fn().mockResolvedValue([row]);
    const repository = new TicketsRepository({
      query,
    } as unknown as Repository<TicketEntity>);

    const page = await repository.page({
      ownerId: ticket.ownerId!,
      statuses: ['active'],
      asOf: new Date('2099-01-10T08:00:00Z'),
      after: null,
      limit: 10,
    });

    expect(page).toHaveLength(1);
    expect(page[0].ticket).toMatchObject({
      refundStatus: 'pending',
      refundPiastres: 7750,
    });
  });
});
