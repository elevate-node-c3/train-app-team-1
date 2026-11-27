import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  TICKET_CANCELLED_EVENT_TYPE,
  TICKET_CANCELLED_VERSION,
  type TicketCancelledEvent,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';

import { TicketCancelledConsumer } from '../../apps/payment/src/modules/charges/consumers/ticket-cancelled.consumer.js';
import { PaymentChargeEntity } from '../../apps/payment/src/modules/charges/entities/payment-charge.entity.js';
import { PaymentChargeRepository } from '../../apps/payment/src/modules/charges/repositories/payment-charge.repository.js';
import { PaymentDoubleService } from '../../apps/payment/src/modules/charges/services/payment-double.service.js';
import type { ChargeCardRepository } from '../../apps/payment/src/modules/charges/repositories/charge-card.repository.js';
import type { PaymentIntentService } from '../../apps/payment/src/modules/charges/services/payment-intent.service.js';
import {
  closePaymentDataSource,
  paymentDataSource,
  truncatePayment,
} from './support/payment-database.js';

const BOOKING = randomUUID();

let ds: DataSource;
let repository: PaymentChargeRepository;
let paymentDouble: PaymentDoubleService;
let consumer: TicketCancelledConsumer;

async function seedCharge(props: {
  bookingReference: string;
  amountPiastres: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO payment_charge
       (id, booking_reference, idempotency_key, amount_piastres, currency, status)
     VALUES ($1, $2, $3, $4, 'EGP', $5)`,
    [
      id,
      props.bookingReference,
      `seed:${id}`,
      props.amountPiastres,
      props.status ?? 'succeeded',
    ],
  );
  return id;
}

async function chargeRow(id: string): Promise<{
  status: string;
  refund_amount_piastres: number | null;
}> {
  const [row] = await ds.query(
    `SELECT status, refund_amount_piastres FROM payment_charge WHERE id = $1`,
    [id],
  );
  return row as {
    status: string;
    refund_amount_piastres: number | null;
  };
}

function ticketCancelled(props: {
  bookingReference: string;
  paymentReference: string;
  ticketId?: string;
  refundPiastres?: number;
}): TicketCancelledEvent {
  return {
    id: randomUUID(),
    type: TICKET_CANCELLED_EVENT_TYPE,
    version: TICKET_CANCELLED_VERSION,
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-1',
    producer: 'booking',
    payload: {
      ticketId: props.ticketId ?? 't1',
      bookingReference: props.bookingReference,
      passengerRef: randomUUID(),
      tripId: randomUUID(),
      coachNumber: 3,
      seatNumber: '12A',
      accountId: randomUUID(),
      refundPiastres: props.refundPiastres ?? 7750,
      paymentReference: props.paymentReference,
    },
  };
}

beforeEach(async () => {
  ds = await paymentDataSource();
  await truncatePayment(ds);
  repository = new PaymentChargeRepository(ds.getRepository(PaymentChargeEntity));
  // refund() only needs the charge repository; the other collaborators belong
  // to start/cancel and are not touched by these cases.
  paymentDouble = new PaymentDoubleService(
    repository,
    {} as ChargeCardRepository,
    {} as PaymentIntentService,
  );
  consumer = new TicketCancelledConsumer(repository, paymentDouble);
});

afterAll(async () => {
  await closePaymentDataSource();
});

describe('TicketCancelledConsumer (real PostgreSQL)', () => {
  it("refunds the ticket's fare share with the derived key", async () => {
    const paymentReference = await seedCharge({
      bookingReference: BOOKING,
      amountPiastres: 20000,
    });
    const refund = vi.spyOn(paymentDouble, 'refund');

    const result = await consumer.handle(
      ticketCancelled({ bookingReference: BOOKING, paymentReference }),
      1,
    );

    expect(result).toEqual({ status: 'handled' });
    expect(await chargeRow(paymentReference)).toMatchObject({
      status: 'refunded',
      refund_amount_piastres: 7750,
    });
    expect(refund).toHaveBeenCalledWith({
      bookingReference: BOOKING,
      paymentReference,
      idempotencyKey: 'ticket:t1:refund',
      amountPiastres: 7750,
    });
  });

  it('is idempotent: the same event delivered twice refunds once', async () => {
    const paymentReference = await seedCharge({
      bookingReference: BOOKING,
      amountPiastres: 20000,
    });
    const envelope = ticketCancelled({
      bookingReference: BOOKING,
      paymentReference,
    });
    const updates = vi.spyOn(repository, 'refundSucceeded');
    const refund = vi.spyOn(paymentDouble, 'refund');

    expect(await consumer.handle(envelope, 1)).toEqual({ status: 'handled' });
    expect(await consumer.handle(envelope, 2)).toEqual({ status: 'handled' });

    expect(updates).toHaveBeenCalledTimes(1);
    expect(await refund.mock.results[1].value).toMatchObject({
      status: 'ALREADY_REFUNDED',
      amountPiastres: 7750,
    });
    expect((await chargeRow(paymentReference)).refund_amount_piastres).toBe(
      7750,
    );
  });

  it('skips an unknown charge rather than retrying it', async () => {
    const result = await consumer.handle(
      ticketCancelled({
        bookingReference: randomUUID(),
        paymentReference: randomUUID(),
      }),
      1,
    );
    expect(result).toEqual({ status: 'skipped', skipReason: 'unknown_charge' });
  });

  it('skips a charge that is not refundable', async () => {
    const paymentReference = await seedCharge({
      bookingReference: BOOKING,
      amountPiastres: 20000,
      status: 'started',
    });

    const result = await consumer.handle(
      ticketCancelled({ bookingReference: BOOKING, paymentReference }),
      1,
    );

    expect(result).toEqual({ status: 'skipped', skipReason: 'not_refundable' });
    expect((await chargeRow(paymentReference)).status).toBe('started');
  });

  it('rejects a malformed payload with a permanent error', async () => {
    const envelope = ticketCancelled({
      bookingReference: BOOKING,
      paymentReference: randomUUID(),
    });
    envelope.payload = { ...envelope.payload, passengerRef: '' };

    try {
      await consumer.handle(envelope, 1);
      expect.unreachable('a malformed payload must not be handled');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PermanentEventError);
      expect(error).toMatchObject({ reason: 'invalid-payload' });
    }
  });
});
