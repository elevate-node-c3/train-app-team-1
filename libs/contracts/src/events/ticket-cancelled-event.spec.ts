import { describe, expect, it } from 'vitest';
import {
  isEventEnvelope,
  TICKET_CANCELLED_EVENT_TYPE,
  type TicketCancelledEvent,
} from '@app/contracts';

describe('ticket.cancelled event', () => {
  it('is a valid event envelope', () => {
    const event: TicketCancelledEvent = {
      id: '11111111-1111-4111-8111-111111111111',
      type: TICKET_CANCELLED_EVENT_TYPE,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-1',
      producer: 'booking',
      payload: {
        ticketId: 't1',
        bookingReference: 'b1',
        passengerRef: 'p1',
        tripId: 'trip1',
        coachNumber: 1,
        seatNumber: '1A',
        accountId: 'u1',
        refundPiastres: 7750,
        paymentReference: 'ch_1',
      },
    };

    expect(isEventEnvelope(event)).toBe(true);
  });
});
