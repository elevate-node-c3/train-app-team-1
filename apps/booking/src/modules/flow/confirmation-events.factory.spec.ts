import { describe, expect, it } from 'vitest';
import {
  buildBookingConfirmed,
  buildBookingRefunded,
  buildBookingSeatsChanged,
} from './confirmation-events.factory.js';

const OCCURRED_AT = new Date('2026-11-21T10:00:00.000Z');

describe('confirmation-events.factory', () => {
  it('builds a booking.confirmed envelope carrying its tickets', () => {
    const event = buildBookingConfirmed({
      eventId: 'evt-1',
      correlationId: 'corr-1',
      occurredAt: OCCURRED_AT,
      payload: {
        bookingReference: 'booking-1',
        totalPiastres: 6955,
        tickets: [
          {
            ticketNumber: 'TKT-1',
            passengerRef: 'p1',
            tripId: 'trip-1',
            coachNumber: 1,
            seatNumber: '1A',
          },
        ],
      },
    });
    expect(event.type).toBe('booking.confirmed');
    expect(event.version).toBe(1);
    expect(event.producer).toBe('booking');
    expect(event.occurredAt).toBe('2026-11-21T10:00:00.000Z');
    expect(event.payload.tickets).toHaveLength(1);
  });

  it('builds a booking.seats-changed envelope', () => {
    const event = buildBookingSeatsChanged({
      eventId: 'evt-2',
      correlationId: 'corr-1',
      occurredAt: OCCURRED_AT,
      payload: {
        bookingReference: 'booking-1',
        seats: [
          { passengerRef: 'p1', tripId: 'trip-1', coachNumber: 2, seatNumber: '3B' },
        ],
      },
    });
    expect(event.type).toBe('booking.seats-changed');
    expect(event.payload.seats[0].seatNumber).toBe('3B');
  });

  it('builds a booking.refunded envelope with a reason key, not prose', () => {
    const event = buildBookingRefunded({
      eventId: 'evt-3',
      correlationId: 'corr-1',
      occurredAt: OCCURRED_AT,
      payload: {
        bookingReference: 'booking-1',
        amountPiastres: 6955,
        reasonKey: 'REASON_NO_SEATS_AFTER_LATE_PAYMENT',
      },
    });
    expect(event.type).toBe('booking.refunded');
    expect(event.payload.reasonKey).toBe('REASON_NO_SEATS_AFTER_LATE_PAYMENT');
  });
});
