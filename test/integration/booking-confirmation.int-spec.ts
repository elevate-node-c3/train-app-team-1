import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import type { DataSource } from 'typeorm';

import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';
import {
  closeInventoryDataSource,
  INVENTORY_DATABASE_URL,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import {
  closePaymentDataSource,
  PAYMENT_DATABASE_URL,
  paymentDataSource,
  truncatePayment,
} from './support/payment-database.js';
import { BOOKING_DATABASE_URL } from './support/booking-database.js';
import {
  aLiveHoldAwaitingPayment,
  bookingSagaInstance,
  clientsFor,
  clsInstance,
  driveSaga,
  expireTheHold,
  inventorySettlementFor,
  isolatedConfirmationEndpoints,
  outboxRelayFor,
  publishPaymentSucceeded,
  publishedCount,
  refundedAmount,
  sellEverySeatInClass,
  soldCount,
  soldCountForBooking,
  state,
  ticketCount,
  type BookingSagaInstance,
  type LiveBooking,
} from './support/booking-confirmation-fixture.js';

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

/**
 * TA-107's acceptance criteria, end to end. Scoped down by an explicit
 * ruling (see the plan's ledger): real Postgres, real RabbitMQ, the real
 * outbox relay and the real event consumer all run; `settleHold` and
 * `refundCharge` call the real inventory/payment service objects directly
 * in-process rather than over gRPC, and "restart" means closing and
 * re-creating this harness's own instances rather than a literal Docker
 * container kill -- those containers are not part of local dev at all.
 */
describe('TA-107 confirmation saga, end to end', () => {
  let inventorySource: DataSource;
  let paymentSource: DataSource;
  let cls: ClsService;
  let paymentRelay: Awaited<ReturnType<typeof outboxRelayFor>>;
  let bookingSource: DataSource;
  let saga: BookingSagaInstance;

  beforeAll(async () => {
    bookingSource = await bookingDataSource();
    inventorySource = await inventoryDataSource();
    paymentSource = await paymentDataSource();
    isolatedConfirmationEndpoints({
      inventory: INVENTORY_DATABASE_URL,
      booking: BOOKING_DATABASE_URL,
      payment: PAYMENT_DATABASE_URL,
    });
    cls = await clsInstance();
    paymentRelay = await outboxRelayFor(paymentSource, cls);
  }, 60_000);

  afterAll(async () => {
    await paymentRelay.close();
    await closeInventoryDataSource();
    await closePaymentDataSource();
  });

  beforeEach(async () => {
    await truncateInventory(inventorySource);
    await truncatePayment(paymentSource);
    const settlement = inventorySettlementFor(inventorySource);
    const clients = clientsFor(settlement, paymentSource);
    saga = await bookingSagaInstance(bookingSource, clients, cls);
    await saga.startConsumer();
  }, 30_000);

  afterEach(async () => {
    await saga.close();
  });

  async function newBooking(
    props: { totalPiastres?: number; passengers?: number } = {},
  ): Promise<LiveBooking> {
    return aLiveHoldAwaitingPayment(
      inventorySource,
      bookingSource,
      paymentSource,
      props,
    );
  }

  it(
    'confirms a booking end to end, from the published event to the tickets',
    async () => {
      const booking = await newBooking({ totalPiastres: 6955 });
      await publishPaymentSucceeded(paymentRelay, booking, {
        amountPiastres: 6955,
      });
      await driveSaga(saga, booking.id);

      expect(await state(bookingSource, booking)).toBe('confirmed');
      expect(await ticketCount(bookingSource, booking)).toBe(
        booking.passengers.length * booking.legs.length,
      );
      expect(await soldCount(inventorySource, booking.tripId)).toBe(
        booking.passengers.length,
      );
    },
    30_000,
  );

  it(
    "does not confirm on the client's word alone",
    async () => {
      const booking = await newBooking();
      expect(await state(bookingSource, booking)).toBe('awaiting_payment');
      expect(await ticketCount(bookingSource, booking)).toBe(0);
    },
    30_000,
  );

  it(
    'sells once and publishes once when the event is delivered twice',
    async () => {
      const booking = await newBooking();
      const eventId = randomUUID();
      await publishPaymentSucceeded(paymentRelay, booking, { eventId });
      await publishPaymentSucceeded(paymentRelay, booking, { eventId });
      await driveSaga(saga, booking.id);

      expect(await ticketCount(bookingSource, booking)).toBe(
        booking.passengers.length,
      );
      expect(
        await publishedCount(bookingSource, 'booking.confirmed', booking),
      ).toBe(1);
    },
    30_000,
  );

  it(
    'issues the tickets exactly once when booking is killed between selling and issuing',
    async () => {
      const booking = await newBooking();
      await publishPaymentSucceeded(paymentRelay, booking);
      await driveSaga(saga, booking.id, {
        stopAtSagaStep: 'settled',
      });

      // Kill the container, start it again: close this instance, build a new one.
      await saga.close();
      const settlement = inventorySettlementFor(inventorySource);
      const clients = clientsFor(settlement, paymentSource);
      saga = await bookingSagaInstance(bookingSource, clients, cls);
      await saga.startConsumer();

      await driveSaga(saga, booking.id);

      expect(await state(bookingSource, booking)).toBe('confirmed');
      expect(await ticketCount(bookingSource, booking)).toBe(
        booking.passengers.length,
      );
    },
    30_000,
  );

  it(
    'confirms a booking whose event arrived while it was stopped',
    async () => {
      const booking = await newBooking();
      await saga.stopConsumer();
      await publishPaymentSucceeded(paymentRelay, booking);
      await saga.startConsumer();

      await driveSaga(saga, booking.id);

      expect(await state(bookingSource, booking)).toBe('confirmed');
    },
    30_000,
  );

  it(
    'sells once across a restart between two deliveries of the same event',
    async () => {
      const booking = await newBooking();
      const eventId = randomUUID();
      await publishPaymentSucceeded(paymentRelay, booking, { eventId });
      await driveSaga(saga, booking.id);

      await saga.close();
      const settlement = inventorySettlementFor(inventorySource);
      const clients = clientsFor(settlement, paymentSource);
      saga = await bookingSagaInstance(bookingSource, clients, cls);
      await saga.startConsumer();

      await publishPaymentSucceeded(paymentRelay, booking, { eventId });
      await driveSaga(saga, booking.id);

      expect(await ticketCount(bookingSource, booking)).toBe(
        booking.passengers.length,
      );
    },
    30_000,
  );

  it(
    'refunds the whole total when no seat is left after a late payment',
    async () => {
      const booking = await newBooking({ totalPiastres: 6955 });
      await expireTheHold(inventorySource, booking);
      await sellEverySeatInClass(
        inventorySource,
        booking.tripId,
        booking.travelClassId,
      );
      await publishPaymentSucceeded(paymentRelay, booking, {
        amountPiastres: 6955,
      });
      await driveSaga(saga, booking.id);

      expect(await state(bookingSource, booking)).toBe('refunded');
      expect(await ticketCount(bookingSource, booking)).toBe(0);
      expect(await refundedAmount(bookingSource, booking)).toBe(6955);
    },
    30_000,
  );

  it(
    'produces exactly one outcome when the hold expires and the payment lands together',
    async () => {
      const booking = await newBooking();
      await Promise.all([
        expireTheHold(inventorySource, booking),
        publishPaymentSucceeded(paymentRelay, booking),
      ]);
      await driveSaga(saga, booking.id);

      const final = await state(bookingSource, booking);
      expect(['confirmed', 'refunded']).toContain(final);
      if (final === 'confirmed') {
        expect(await refundedAmount(bookingSource, booking)).toBe(0);
      } else {
        expect(await soldCountForBooking(inventorySource, booking)).toBe(0);
      }
    },
    30_000,
  );

  it(
    'confirms even when nothing is listening for booking.confirmed',
    async () => {
      const booking = await newBooking();
      await publishPaymentSucceeded(paymentRelay, booking);
      await driveSaga(saga, booking.id);

      expect(await state(bookingSource, booking)).toBe('confirmed');
      expect(
        await publishedCount(bookingSource, 'booking.confirmed', booking),
      ).toBe(1);
    },
    30_000,
  );
});
