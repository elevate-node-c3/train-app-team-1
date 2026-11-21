import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';

let ds: DataSource;

const BOOKING = randomUUID();
const TRIP = randomUUID();
const OUTBOUND = randomUUID();
const RETURN = randomUUID();

async function seedDraft(id: string): Promise<void> {
  await ds.query(
    `INSERT INTO booking_draft (id, user_id) VALUES ($1, $2)`,
    [id, randomUUID()],
  );
}

async function insertTicket(
  source: DataSource,
  props: {
    bookingReference: string;
    passengerRef: string;
    tripId: string;
    ticketNumber: string;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  await source.query(
    `INSERT INTO ticket
       (id, booking_reference, passenger_ref, trip_id, ticket_number,
        coach_number, seat_number)
     VALUES ($1, $2, $3, $4, $5, 1, '1A')`,
    [id, props.bookingReference, props.passengerRef, props.tripId, props.ticketNumber],
  );
  return { id };
}

async function setFlowState(
  source: DataSource,
  bookingReference: string,
  state: string,
): Promise<{ flow_state: string }> {
  const rows: { flow_state: string }[] = await source.query(
    `UPDATE booking_draft SET flow_state = $2 WHERE id = $1 RETURNING flow_state`,
    [bookingReference, state],
  );
  return rows[0];
}

beforeEach(async () => {
  ds = await bookingDataSource();
  await truncateBooking(ds);
  await seedDraft(BOOKING);
});

afterAll(async () => {
  await closeBookingDataSource();
});

describe('booking confirmation saga schema', () => {
  it('refuses a second ticket for the same passenger on the same leg', async () => {
    await insertTicket(ds, {
      bookingReference: BOOKING,
      passengerRef: 'p1',
      tripId: TRIP,
      ticketNumber: 'TKT-1',
    });
    await expect(
      insertTicket(ds, {
        bookingReference: BOOKING,
        passengerRef: 'p1',
        tripId: TRIP,
        ticketNumber: 'TKT-2',
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('allows the same passenger a ticket on the other leg of a round trip', async () => {
    await insertTicket(ds, {
      bookingReference: BOOKING,
      passengerRef: 'p1',
      tripId: OUTBOUND,
      ticketNumber: 'TKT-1',
    });
    await expect(
      insertTicket(ds, {
        bookingReference: BOOKING,
        passengerRef: 'p1',
        tripId: RETURN,
        ticketNumber: 'TKT-2',
      }),
    ).resolves.toBeDefined();
  });

  it('accepts the four new flow states and refuses an invented one', async () => {
    for (const state of ['confirming', 'confirmed', 'refunding', 'refunded']) {
      await expect(setFlowState(ds, BOOKING, state)).resolves.toBeDefined();
    }
    await expect(
      setFlowState(ds, BOOKING, 'nearly_confirmed'),
    ).rejects.toThrow(/chk_booking_draft_flow_state/);
  });
});
