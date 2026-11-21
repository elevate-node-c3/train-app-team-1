import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import type { EventEnvelope } from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';

import { BookingDraftEntity } from '../draft/entities/booking-draft.entity.js';
import type {
  BookingFlowState,
  CompensationStatus,
} from '../draft/entities/booking-draft.entity.js';
import { TicketEntity } from './entities/ticket.entity.js';
import { BookingFlowRepository } from './booking-flow.repository.js';
import { PaymentSucceededConsumer } from './payment-succeeded.consumer.js';
import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from '../../../../../test/integration/support/booking-database.js';

const BOOKING = randomUUID();
const UNKNOWN = randomUUID();

let ds: DataSource;
let repository: BookingFlowRepository;
let consumer: PaymentSucceededConsumer;

async function seed(
  source: DataSource,
  props: {
    flowState: BookingFlowState;
    compensationStatus?: CompensationStatus;
    paymentReference?: string | null;
    paymentSucceededAt?: Date;
  },
): Promise<void> {
  const compensationStatus = props.compensationStatus ?? 'none';
  await source.query(
    `INSERT INTO booking_draft
       (id, user_id, flow_state, compensation_status, compensation_next_attempt_at,
        payment_reference, payment_succeeded_at, resume_next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      BOOKING,
      randomUUID(),
      props.flowState,
      compensationStatus,
      compensationStatus === 'pending' ? new Date() : null,
      props.paymentReference ?? null,
      props.paymentSucceededAt ?? null,
    ],
  );
}

async function read(source: DataSource, bookingReference: string) {
  const [row] = await source.query(
    `SELECT flow_state, payment_event_id, compensation_status,
            compensation_next_attempt_at, resume_next_attempt_at
       FROM booking_draft WHERE id = $1`,
    [bookingReference],
  );
  return row as {
    flow_state: string;
    payment_event_id: string | null;
    compensation_status: string;
    compensation_next_attempt_at: Date | null;
    resume_next_attempt_at: Date | null;
  };
}

function input(): { bookingReference: string; paymentEventId: string } {
  return { bookingReference: BOOKING, paymentEventId: 'evt_1' };
}

function paymentSucceeded(
  props: { bookingReference: string } & Partial<EventEnvelope>,
): EventEnvelope {
  return {
    id: props.id ?? randomUUID(),
    type: 'payment.charge.succeeded',
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-1',
    producer: 'payment',
    payload: {
      bookingReference: props.bookingReference,
      paymentReference: randomUUID(),
      amountPiastres: 6955,
      currency: 'EGP',
      stripeEventId: 'evt_1',
    },
    ...props,
  };
}

beforeEach(async () => {
  ds = await bookingDataSource();
  await truncateBooking(ds);
  repository = new BookingFlowRepository(
    ds.getRepository(BookingDraftEntity),
    ds.getRepository(TicketEntity),
  );
  consumer = new PaymentSucceededConsumer(repository);
});

afterAll(async () => {
  await closeBookingDataSource();
});

describe('BookingFlowRepository.beginConfirming', () => {
  it('moves an awaiting_payment booking to confirming and stands compensation down', async () => {
    await seed(ds, { flowState: 'awaiting_payment', compensationStatus: 'none' });
    expect(
      await repository.beginConfirming({
        bookingReference: BOOKING,
        paymentEventId: 'evt_1',
      }),
    ).toBe(true);
    const row = await read(ds, BOOKING);
    expect(row.flow_state).toBe('confirming');
    expect(row.payment_event_id).toBe('evt_1');
    expect(row.compensation_status).toBe('none');
    expect(row.compensation_next_attempt_at).toBeNull();
    expect(row.resume_next_attempt_at).not.toBeNull();
  });

  it('takes an expired booking whose compensation is pending, and stops that compensation', async () => {
    await seed(ds, { flowState: 'expired', compensationStatus: 'pending' });
    expect(await repository.beginConfirming(input())).toBe(true);
    const row = await read(ds, BOOKING);
    expect(row.flow_state).toBe('confirming');
    expect(row.compensation_status).toBe('none');
  });

  it('takes a booking still in payment_starting, before its reference was recorded', async () => {
    await seed(ds, { flowState: 'payment_starting', paymentReference: null });
    expect(await repository.beginConfirming(input())).toBe(true);
  });

  it('is a no-op the second time', async () => {
    await seed(ds, { flowState: 'awaiting_payment' });
    await repository.beginConfirming(input());
    expect(await repository.beginConfirming(input())).toBe(false);
  });

  it('will not drag a confirmed booking backwards', async () => {
    await seed(ds, { flowState: 'confirmed', paymentSucceededAt: new Date() });
    expect(await repository.beginConfirming(input())).toBe(false);
  });
});

describe('PaymentSucceededConsumer', () => {
  it('skips an event for a booking it does not know, rather than failing it', async () => {
    const result = await consumer.handle(
      paymentSucceeded({ bookingReference: UNKNOWN }),
    );
    expect(result).toEqual({ status: 'skipped', skipReason: 'unknown_booking' });
  });

  it('handles a verified payment for a known booking', async () => {
    await seed(ds, { flowState: 'awaiting_payment' });
    const result = await consumer.handle(
      paymentSucceeded({ bookingReference: BOOKING }),
    );
    expect(result).toEqual({ status: 'handled' });
    expect((await read(ds, BOOKING)).flow_state).toBe('confirming');
  });

  it('is a no-op, not a skip, when the same event is handled twice', async () => {
    await seed(ds, { flowState: 'awaiting_payment' });
    await consumer.handle(paymentSucceeded({ bookingReference: BOOKING }));
    const result = await consumer.handle(
      paymentSucceeded({ bookingReference: BOOKING }),
    );
    expect(result).toEqual({ status: 'handled' });
  });

  it('rejects a malformed payload with a permanent error', async () => {
    const envelope = paymentSucceeded({ bookingReference: BOOKING });
    envelope.payload = { ...(envelope.payload as object), amountPiastres: -1 };
    await expect(consumer.handle(envelope)).rejects.toThrow(
      PermanentEventError,
    );
  });
});
