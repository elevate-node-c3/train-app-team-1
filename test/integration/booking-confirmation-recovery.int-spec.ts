import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DataSource } from 'typeorm';
import { EVENT_TYPES } from '@app/contracts';
import {
  BOOKING_DATABASE_URL,
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';
import {
  INVENTORY_DATABASE_URL,
  inventoryDataSource,
  closeInventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import {
  PAYMENT_DATABASE_URL,
  paymentDataSource,
  closePaymentDataSource,
  truncatePayment,
} from './support/payment-database.js';
import {
  aLiveHoldAwaitingPayment,
  clsInstance,
  expireTheHold,
  isolatedConfirmationEndpoints,
  outboxRelayFor,
  outcomeQueueFor,
  processedPaymentEvent,
  publishPaymentSucceeded,
  publishedCount,
  redeliverPaymentSucceeded,
  refundedAmount,
  sagaStep,
  sellEverySeatInClass,
  soldCountForBooking,
  state,
  ticketCount,
  waitFor,
  type LiveBooking,
} from './support/booking-confirmation-fixture.js';
import { confirmationGrpcFixture } from './support/booking-confirmation-grpc.js';
import { BookingProcess } from './support/booking-confirmation-subprocess.js';
import { ephemeralRabbitVhost } from './support/rabbit-vhost.js';

// These tests truncate local fixture databases. Only the isolated holds tier
// runs them. Booking runs in a separate OS process, not recreated Node objects.
describe('TA-107 production booking worker process and gRPC recovery', () => {
  let bookingSource: DataSource;
  let inventorySource: DataSource;
  let paymentSource: DataSource;
  let relay: Awaited<ReturnType<typeof outboxRelayFor>>;
  let grpc: Awaited<ReturnType<typeof confirmationGrpcFixture>>;
  let outcomes: Awaited<ReturnType<typeof outcomeQueueFor>>;
  let vhost: Awaited<ReturnType<typeof ephemeralRabbitVhost>> | undefined;
  const children: BookingProcess[] = [];
  const credential = `confirmation-test-only-${randomUUID()}`;

  beforeAll(async () => {
    isolatedConfirmationEndpoints({
      booking: BOOKING_DATABASE_URL,
      inventory: INVENTORY_DATABASE_URL,
      payment: PAYMENT_DATABASE_URL,
    });
    vhost = await ephemeralRabbitVhost('booking-confirmation-recovery');
    vi.stubEnv('HOLDS_TEST_RABBITMQ_URL', vhost.rabbit);
    vi.stubEnv('RABBITMQ_URL', vhost.rabbit);
    vi.stubEnv('BOOKING_INVENTORY_SERVICE_KEY', credential);
    bookingSource = await bookingDataSource();
    inventorySource = await inventoryDataSource();
    paymentSource = await paymentDataSource();
    relay = await outboxRelayFor(paymentSource, await clsInstance());
    grpc = await confirmationGrpcFixture(inventorySource, paymentSource);
    outcomes = await outcomeQueueFor(relay.amqp);
  }, 120_000);

  beforeEach(async () => {
    grpc.receipts.length = 0;
    await truncateBooking(bookingSource);
    await truncateInventory(inventorySource);
    await truncatePayment(paymentSource);
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => child.close()));
  }, 30_000);

  afterAll(async () => {
    try {
      await grpc?.close();
      await outcomes?.close();
      await relay?.close();
      await closeBookingDataSource();
      await closeInventoryDataSource();
      await closePaymentDataSource();
    } finally {
      try {
        await vhost?.close();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  async function start(crashBookingId?: string): Promise<BookingProcess> {
    const child = new BookingProcess({
      RABBITMQ_URL: process.env.RABBITMQ_URL!,
      INVENTORY_GRPC_URL: grpc.inventoryUrl,
      PAYMENT_GRPC_URL: grpc.paymentUrl,
      CATALOG_GRPC_URL: grpc.inventoryUrl, // No quote/pre-payment RPC is used by these seeded flows.
      IDENTITY_GRPC_URL: grpc.inventoryUrl,
      BOOKING_INVENTORY_SERVICE_KEY: credential,
      CONFIRMATION_CRASH_BOOKING_ID: crashBookingId ?? '',
    });
    children.push(child);
    await child.waitForMessage((message) => message.type === 'ready');
    return child;
  }

  function newBooking(): Promise<LiveBooking> {
    return aLiveHoldAwaitingPayment(
      inventorySource,
      bookingSource,
      paymentSource,
    );
  }

  async function finished(
    booking: LiveBooking,
    expected = 'confirmed',
  ): Promise<void> {
    await waitFor(
      () => state(bookingSource, booking),
      (value) => value === expected,
      `production worker to reach ${expected}`,
      60_000,
    );
    await waitFor(
      () => publishedCount(bookingSource, `booking.${expected}`, booking),
      (count) => count === 1,
      'production outbox publication',
      30_000,
    );
  }

  async function recoveryRow(booking: LiveBooking) {
    const [row]: {
      saga_step: string;
      lease_owner: string | null;
      lease_until: Date | null;
      resume_attempts: number;
      lease_live: boolean;
      server_now: Date;
    }[] = await bookingSource.query(
      `SELECT saga_step, lease_owner, lease_until, resume_attempts,
         COALESCE(lease_until > clock_timestamp(), false) AS lease_live,
         clock_timestamp() AS server_now FROM booking_draft WHERE id = $1`,
      [booking.id],
    );
    return row;
  }

  it('rejects missing inventory credentials over the real transport before selling', async () => {
    const booking = await newBooking();
    await expect(
      firstValueFrom(
        grpc.inventoryClient.settleHold(
          { ownerId: booking.ownerId, bookingKey: booking.id },
          new Metadata(),
          { deadline: Date.now() + 5_000 },
        ),
      ),
    ).rejects.toMatchObject({ code: grpcStatus.PERMISSION_DENIED });
    expect(await soldCountForBooking(inventorySource, booking)).toBe(0);
    expect(grpc.receipts).toHaveLength(0);
  });

  it('recovers a committed sale whose SettleHold response was lost at the gRPC deadline', async () => {
    const booking = await newBooking();
    await start();
    const fault = grpc.loseNextSettlementResponse(booking.id);
    try {
      await publishPaymentSucceeded(relay, booking);
      await waitFor(
        async () =>
          grpc.receipts.some((receipt) => receipt.bookingId === booking.id),
        Boolean,
        'inventory to commit the faulted settlement',
        30_000,
      );
      const committed = await fault.committed;
      expect(committed.outcome).toBe('SOLD');
      expect(await soldCountForBooking(inventorySource, booking)).toBe(
        booking.passengers.length,
      );
      expect(await sagaStep(bookingSource, booking)).toBe('payment_recorded');
      await waitFor(
        () => recoveryRow(booking),
        (row) => row.resume_attempts >= 1 && row.lease_owner === null,
        'worker to persist retry after the actual gRPC deadline',
      );
      fault.release();
      await finished(booking);
      const receipts = grpc.receipts.filter(
        (receipt) => receipt.bookingId === booking.id,
      );
      expect(receipts.length).toBeGreaterThanOrEqual(2);
      expect(receipts[1].snapshot).toMatchObject({
        outcome: receipts[0].snapshot.outcome,
        holdId: receipts[0].snapshot.holdId,
        assignments: receipts[0].snapshot.assignments,
        legs: receipts[0].snapshot.legs,
      });
      expect(await soldCountForBooking(inventorySource, booking)).toBe(
        booking.passengers.length,
      );
      expect(await ticketCount(bookingSource, booking)).toBe(
        booking.passengers.length,
      );
    } finally {
      fault.release();
    }
  }, 90_000);

  it('retains REALLOCATED and its seat-change event when the first gRPC response is lost', async () => {
    const booking = await newBooking();
    await expireTheHold(inventorySource, booking);
    await inventorySource.transaction(async (manager) => {
      const seats: {
        trip_seat_id: string;
        trip_id: string;
        segment: string;
      }[] = await manager.query(
        'SELECT trip_seat_id, trip_id, segment::text FROM seat_occupation WHERE hold_id = $1 AND released_at IS NULL',
        [booking.holdId],
      );
      await manager.query(
        'UPDATE seat_occupation SET released_at = clock_timestamp() WHERE hold_id = $1',
        [booking.holdId],
      );
      for (const seat of seats)
        await manager.query(
          `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
         VALUES ($1, $2, $3, $4::int4range, 'sold', NULL)`,
          [randomUUID(), seat.trip_seat_id, seat.trip_id, seat.segment],
        );
    });
    await start();
    const fault = grpc.loseNextSettlementResponse(booking.id);
    try {
      await publishPaymentSucceeded(relay, booking);
      await waitFor(
        async () =>
          grpc.receipts.some((receipt) => receipt.bookingId === booking.id),
        Boolean,
        'reallocation to commit',
        30_000,
      );
      const committed = await fault.committed;
      expect(committed.outcome).toBe('REALLOCATED');
      await waitFor(
        () => recoveryRow(booking),
        (row) => row.resume_attempts >= 1 && row.lease_owner === null,
        'lost reallocation response retry',
      );
      fault.release();
      await finished(booking);
      await waitFor(
        () =>
          publishedCount(
            bookingSource,
            EVENT_TYPES.bookingSeatsChanged,
            booking,
          ),
        (count) => count === 1,
        'one seat-change event',
      );
      const receipts = grpc.receipts.filter(
        (receipt) => receipt.bookingId === booking.id,
      );
      expect(receipts.length).toBeGreaterThanOrEqual(2);
      expect(receipts[1].snapshot).toMatchObject({
        outcome: 'REALLOCATED',
        assignments: committed.assignments,
      });
      const [draft] = await bookingSource.query(
        'SELECT seats_changed, settled_seats FROM booking_draft WHERE id = $1',
        [booking.id],
      );
      expect(draft.seats_changed).toBe(true);
      expect(draft.settled_seats).toEqual(
        committed.assignments.map((assignment) => ({
          passengerRef: assignment.passengerRef,
          tripId: assignment.tripId,
          coachNumber: assignment.coachNumber,
          seatNumber: assignment.seatNumber,
          tripSeatId: assignment.tripSeatId,
          outcome: assignment.outcome,
          ...(assignment.label === undefined
            ? {}
            : { label: assignment.label }),
        })),
      );
      expect(await soldCountForBooking(inventorySource, booking)).toBe(
        booking.passengers.length,
      );
      expect(await ticketCount(bookingSource, booking)).toBe(
        booking.passengers.length,
      );
    } finally {
      fault.release();
    }
  }, 90_000);

  it('keeps a lost NO_SEATS decision immutable when capacity becomes available before retry', async () => {
    const booking = await newBooking();
    await expireTheHold(inventorySource, booking);
    await sellEverySeatInClass(
      inventorySource,
      booking.tripId,
      booking.travelClassId,
    );
    await start();
    const fault = grpc.loseNextSettlementResponse(booking.id);
    try {
      await publishPaymentSucceeded(relay, booking);
      await waitFor(
        async () =>
          grpc.receipts.some((receipt) => receipt.bookingId === booking.id),
        Boolean,
        'no-seats decision to commit',
        30_000,
      );
      expect((await fault.committed).outcome).toBe('NO_SEATS');
      await inventorySource.query(
        `UPDATE seat_occupation SET released_at = clock_timestamp()
         WHERE trip_id = $1 AND hold_id IS NULL AND state = 'sold' AND released_at IS NULL`,
        [booking.tripId],
      );
      await waitFor(
        () => recoveryRow(booking),
        (row) => row.resume_attempts >= 1 && row.lease_owner === null,
        'lost refusal response retry',
      );
      fault.release();
      await finished(booking, 'refunded');
      const receipts = grpc.receipts.filter(
        (receipt) => receipt.bookingId === booking.id,
      );
      expect(receipts.length).toBeGreaterThanOrEqual(2);
      expect(
        receipts.every((receipt) => receipt.snapshot.outcome === 'NO_SEATS'),
      ).toBe(true);
      expect(await soldCountForBooking(inventorySource, booking)).toBe(0);
      expect(await ticketCount(bookingSource, booking)).toBe(0);
      expect(await refundedAmount(bookingSource, booking)).toBe(
        booking.totalPiastres,
      );
    } finally {
      fault.release();
    }
  }, 90_000);

  it('waits for the crashed worker lease and sells/issues once after a real abrupt process kill', async () => {
    const booking = await newBooking();
    const first = await start(booking.id);
    await publishPaymentSucceeded(relay, booking);
    await first.waitForMessage(
      (message) =>
        message.type === 'before-settlement-record' &&
        message.bookingId === booking.id,
    );
    const leased = await recoveryRow(booking);
    expect(leased).toMatchObject({
      saga_step: 'payment_recorded',
      lease_live: true,
    });
    expect(leased.lease_owner).toBeTruthy();
    expect(await soldCountForBooking(inventorySource, booking)).toBe(
      booking.passengers.length,
    );
    expect(await ticketCount(bookingSource, booking)).toBe(0);
    const death = await first.killAbruptly();
    if (process.platform !== 'win32') expect(death.signal).toBe('SIGKILL');
    else expect(death.code).not.toBe(0);
    const second = await start();
    expect(second.child.pid).not.toBe(first.child.pid);
    const afterRestart = await recoveryRow(booking);
    if (afterRestart.server_now < leased.lease_until!) {
      expect(afterRestart.resume_attempts).toBe(leased.resume_attempts);
      expect(await ticketCount(bookingSource, booking)).toBe(0);
    }
    await finished(booking);
    const recovered = await recoveryRow(booking);
    expect(recovered.server_now.getTime()).toBeGreaterThanOrEqual(
      leased.lease_until!.getTime(),
    );
    expect(recovered.resume_attempts).toBeGreaterThan(leased.resume_attempts);
    expect(await soldCountForBooking(inventorySource, booking)).toBe(
      booking.passengers.length,
    );
    expect(await ticketCount(bookingSource, booking)).toBe(
      booking.passengers.length,
    );
    expect(await refundedAmount(bookingSource, booking)).toBe(0);
  }, 120_000);

  it('observes the identical duplicate delivery after abrupt process restart without issuing twice', async () => {
    const booking = await newBooking();
    const first = await start();
    const event = await publishPaymentSucceeded(relay, booking);
    const delivery = await first.waitForMessage(
      (message) => message.type === 'delivery' && message.eventId === event.id,
    );
    await finished(booking);
    await first.killAbruptly();
    const second = await start();
    await redeliverPaymentSucceeded(relay, event);
    const redelivery = await second.waitForMessage(
      (message) => message.type === 'delivery' && message.eventId === event.id,
    );
    expect(redelivery.contentHash).toBe(delivery.contentHash);
    expect(await processedPaymentEvent(bookingSource, event.id)).toMatchObject([
      { event_id: event.id, status: 'handled', attempt_count: 1 },
    ]);
    expect(await ticketCount(bookingSource, booking)).toBe(
      booking.passengers.length,
    );
    expect(await soldCountForBooking(inventorySource, booking)).toBe(
      booking.passengers.length,
    );
    expect(
      await publishedCount(bookingSource, 'booking.confirmed', booking),
    ).toBe(1);
    expect(
      grpc.receipts.filter((receipt) => receipt.bookingId === booking.id),
    ).toHaveLength(1);
  }, 120_000);

  it('consumes a payment queued while the booking process is stopped', async () => {
    const initial = await start(); // Declares the real durable consumer queue.
    await initial.killAbruptly();
    const booking = await newBooking();
    const event = await publishPaymentSucceeded(relay, booking);
    expect(await state(bookingSource, booking)).toBe('awaiting_payment');
    const restarted = await start();
    await restarted.waitForMessage(
      (message) => message.type === 'delivery' && message.eventId === event.id,
    );
    await finished(booking);
    expect(await ticketCount(bookingSource, booking)).toBe(
      booking.passengers.length,
    );
  }, 120_000);

  it('uses the production worker and real payment RefundCharge transport for a full no-seat refund', async () => {
    const booking = await newBooking();
    await expireTheHold(inventorySource, booking);
    await sellEverySeatInClass(
      inventorySource,
      booking.tripId,
      booking.travelClassId,
    );
    await start();
    await publishPaymentSucceeded(relay, booking);
    await finished(booking, 'refunded');
    expect(await refundedAmount(bookingSource, booking)).toBe(
      booking.totalPiastres,
    );
    expect(await ticketCount(bookingSource, booking)).toBe(0);
    expect(await soldCountForBooking(inventorySource, booking)).toBe(0);
    const [charge] = await paymentSource.query(
      'SELECT status, amount_piastres FROM payment_charge WHERE id = $1',
      [booking.paymentReference],
    );
    expect(charge).toMatchObject({
      status: 'refunded',
      amount_piastres: booking.totalPiastres,
    });
  }, 90_000);
});
