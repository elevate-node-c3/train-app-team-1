import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { TypeOrmOutboxRepository } from '@app/messaging';
import type { EventEnvelope } from '@app/contracts';

import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../../apps/booking/src/modules/flow/entities/ticket.entity.js';
import { BookingFlowRepository } from '../../apps/booking/src/modules/flow/booking-flow.repository.js';
import { TicketIssuerService } from '../../apps/booking/src/modules/flow/services/ticket-issuer.service.js';
import { TicketCancellationRepository } from '../../apps/booking/src/modules/flow/services/ticket-cancellation.repository.js';
import { TicketCancellationService } from '../../apps/booking/src/modules/flow/services/ticket-cancellation.service.js';
import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';
import {
  TEST_TRAVEL_CLASS,
  testQuotedLeg,
  testTicketSigner,
} from './support/ticket-fixture.js';

import {
  closeInventoryDataSource,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import {
  occupationState,
  seedSoldSeat,
} from './support/sold-seat-fixture.js';
import { seedSixStopTrip, SIX_STOP_TRIP } from './support/inventory-fixture.js';
import { SoldSeatReleaseService } from '../../apps/inventory/src/modules/seat-hold/services/sold-seat-release.service.js';
import { TicketCancelledConsumer as InventoryConsumer } from '../../apps/inventory/src/modules/seat-hold/consumers/ticket-cancelled.consumer.js';

import {
  closePaymentDataSource,
  paymentDataSource,
  truncatePayment,
} from './support/payment-database.js';
import { PaymentDoubleService } from '../../apps/payment/src/modules/charges/services/payment-double.service.js';
import { PaymentChargeRepository } from '../../apps/payment/src/modules/charges/repositories/payment-charge.repository.js';
import { TicketCancelledConsumer as PaymentConsumer } from '../../apps/payment/src/modules/charges/consumers/ticket-cancelled.consumer.js';

import { NodemailerEmailSender } from '../../apps/notification/src/modules/verification-emails/email-sender.js';
import { TicketCancelledConsumer as NotificationConsumer } from '../../apps/notification/src/modules/booking-outcomes/consumers/ticket-cancelled.consumer.js';

const OWNER = randomUUID();
const BOOKING_REFERENCE = randomUUID();
const TRIP_ID = SIX_STOP_TRIP.tripId;
const CHARGE_ID = randomUUID();
const PASSENGER_REF = 'passenger-1';

let bookingDs: DataSource;
let inventoryDs: DataSource;
let paymentDs: DataSource;

async function issueTicket(): Promise<string> {
  const now = new Date();
  const departs = new Date(now.getTime() + 48 * 3600_000);
  const arrives = new Date(departs.getTime() + 3 * 3600_000);
  const cairo = (d: Date) => d.toISOString();
  await bookingDs.query(`INSERT INTO booking_draft (id, user_id, payment_reference, total_piastres) VALUES ($1, $2, $3, $4)`, [
    BOOKING_REFERENCE, OWNER, CHARGE_ID, 6955,
  ]);
  const draft = Object.assign(new BookingDraftEntity(), {
    id: BOOKING_REFERENCE,
    userId: OWNER,
    travelClass: TEST_TRAVEL_CLASS,
    quotedLegs: [testQuotedLeg(TRIP_ID, { departs: cairo(departs), arrives: cairo(arrives) })],
    passengerSnapshot: [{ passengerRef: PASSENGER_REF, displayName: 'P', maskedNationalId: '**********1234', identities: [] }],
    settledSeats: [{ passengerRef: PASSENGER_REF, tripId: TRIP_ID, coachNumber: 1, seatNumber: '4' }],
  });
  const unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
  const issuer = new TicketIssuerService(testTicketSigner());
  const tickets = await unitOfWork.withTransaction((ctx) => issuer.issue(ctx, draft));
  return tickets[0].id;
}

beforeEach(async () => {
  bookingDs = await bookingDataSource();
  await truncateBooking(bookingDs);
  inventoryDs = await inventoryDataSource();
  await truncateInventory(inventoryDs);
  await seedSixStopTrip(inventoryDs);
  paymentDs = await paymentDataSource();
  await truncatePayment(paymentDs);
  await paymentDs.query(
    `INSERT INTO payment_charge (id, booking_reference, idempotency_key, amount_piastres, currency, status)
     VALUES ($1, $2, $3, $4, 'EGP', 'succeeded')`,
    [CHARGE_ID, BOOKING_REFERENCE, `charge:${BOOKING_REFERENCE}`, 20000],
  );
  await seedSoldSeat(inventoryDs, { bookingReference: BOOKING_REFERENCE, passengerRef: PASSENGER_REF, from: 0, to: 2 });
});

afterAll(async () => {
  await closeBookingDataSource();
  await closeInventoryDataSource();
  await closePaymentDataSource();
});

describe('TA-109 cancellation end-to-end', () => {
  it('preview then confirm cancels the ticket and writes one outbox event', async () => {
    const ticketId = await issueTicket();
    const repo = new TicketCancellationRepository(bookingDs.getRepository(TicketEntity));
    const bookings = new BookingFlowRepository(bookingDs.getRepository(BookingDraftEntity), bookingDs.getRepository(TicketEntity));
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
    const outbox = new TypeOrmOutboxRepository(new DataSourceInitializer(bookingDs));
    const service = new TicketCancellationService(repo, bookings, uow, outbox, () => new Date());

    const preview = await service.preview(ticketId, OWNER);
    expect(preview.allowed).toBe(true);
    const result = await service.confirm({ ticketId, tier: preview.tier, idempotencyKey: `ticket:${ticketId}:cancel` }, OWNER, 'corr-1');
    expect(result.status).toBe('CANCELLED');

    const [row] = await bookingDs.query(`SELECT status FROM ticket WHERE id = $1`, [ticketId]);
    expect(row.status).toBe('cancelled');
    const events = await bookingDs.query(`SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'ticket.cancelled'`);
    expect(events[0].n).toBe(1);
  });

  it('is cancel-once: a second confirm with a new key is refused', async () => {
    const ticketId = await issueTicket();
    const repo = new TicketCancellationRepository(bookingDs.getRepository(TicketEntity));
    const bookings = new BookingFlowRepository(bookingDs.getRepository(BookingDraftEntity), bookingDs.getRepository(TicketEntity));
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
    const outbox = new TypeOrmOutboxRepository(new DataSourceInitializer(bookingDs));
    const service = new TicketCancellationService(repo, bookings, uow, outbox, () => new Date());

    const preview = await service.preview(ticketId, OWNER);
    await service.confirm({ ticketId, tier: preview.tier, idempotencyKey: `ticket:${ticketId}:cancel` }, OWNER, 'corr-1');
    await expect(
      service.confirm({ ticketId, tier: preview.tier, idempotencyKey: `ticket:${ticketId}:cancel:retry` }, OWNER, 'corr-1'),
    ).rejects.toMatchObject({ code: 'TICKET_ALREADY_CANCELLED' });

    const events = await bookingDs.query(`SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'ticket.cancelled'`);
    expect(events[0].n).toBe(1);
  });

  it('cancelling one ticket of a three-passenger booking leaves the other two active', async () => {
    // Re-seed a three-passenger draft.
    const bookingId = randomUUID();
    const tripId = randomUUID();
    const now = new Date();
    const departs = new Date(now.getTime() + 48 * 3600_000);
    const arrives = new Date(departs.getTime() + 3 * 3600_000);
    const cairo = (d: Date) => d.toISOString();
    await bookingDs.query(`INSERT INTO booking_draft (id, user_id, payment_reference, total_piastres) VALUES ($1, $2, $3, $4)`, [bookingId, OWNER, CHARGE_ID, 6955]);
    const draft = Object.assign(new BookingDraftEntity(), {
      id: bookingId,
      userId: OWNER,
      travelClass: TEST_TRAVEL_CLASS,
      quotedLegs: [testQuotedLeg(tripId, { departs: cairo(departs), arrives: cairo(arrives) })],
      passengerSnapshot: [1, 2, 3].map((n) => ({ passengerRef: `passenger-${n}`, displayName: `P${n}`, maskedNationalId: '**********1234', identities: [] })),
      settledSeats: [1, 2, 3].map((n) => ({ passengerRef: `passenger-${n}`, tripId, coachNumber: 1, seatNumber: String(10 + n) })),
    });
    const unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
    const issuer = new TicketIssuerService(testTicketSigner());
    const tickets = await unitOfWork.withTransaction((ctx) => issuer.issue(ctx, draft));
    expect(tickets).toHaveLength(3);

    const repo = new TicketCancellationRepository(bookingDs.getRepository(TicketEntity));
    const bookings = new BookingFlowRepository(bookingDs.getRepository(BookingDraftEntity), bookingDs.getRepository(TicketEntity));
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
    const outbox = new TypeOrmOutboxRepository(new DataSourceInitializer(bookingDs));
    const service = new TicketCancellationService(repo, bookings, uow, outbox, () => new Date());

    const target = tickets[0];
    const preview = await service.preview(target.id, OWNER);
    await service.confirm({ ticketId: target.id, tier: preview.tier, idempotencyKey: `ticket:${target.id}:cancel` }, OWNER, 'corr-1');

    const statuses = await bookingDs.query(`SELECT id, status FROM ticket WHERE booking_reference = $1 ORDER BY id`, [bookingId]);
    const byId = new Map(statuses.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(byId.get(target.id)).toBe('cancelled');
    for (const t of tickets.slice(1)) {
      expect(byId.get(t.id)).toBe('active');
    }
  });

  it('all three consumers settle from one ticket.cancelled event (seat released, refund requested, email sent)', async () => {
    const ticketId = await issueTicket();
    const repo = new TicketCancellationRepository(bookingDs.getRepository(TicketEntity));
    const bookings = new BookingFlowRepository(bookingDs.getRepository(BookingDraftEntity), bookingDs.getRepository(TicketEntity));
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
    const outbox = new TypeOrmOutboxRepository(new DataSourceInitializer(bookingDs));
    const service = new TicketCancellationService(repo, bookings, uow, outbox, () => new Date());

    const preview = await service.preview(ticketId, OWNER);
    await service.confirm({ ticketId, tier: preview.tier, idempotencyKey: `ticket:${ticketId}:cancel` }, OWNER, 'corr-1');

    // Read the persisted outbox event produced by confirm().
    const [outboxRow] = await bookingDs.query(`SELECT event_type, event_version, payload, correlation_id, producer, occurred_at FROM outbox_event WHERE event_type = 'ticket.cancelled' ORDER BY id DESC LIMIT 1`);
    const payload = typeof outboxRow.payload === 'string' ? JSON.parse(outboxRow.payload) : outboxRow.payload;
    const event: EventEnvelope = {
      id: randomUUID(),
      type: outboxRow.event_type,
      version: outboxRow.event_version,
      occurredAt: outboxRow.occurred_at instanceof Date ? outboxRow.occurred_at.toISOString() : String(outboxRow.occurred_at),
      correlationId: outboxRow.correlation_id,
      producer: outboxRow.producer,
      payload,
    };

    // Align identifiers with the seeded inventory/payment rows.
    (event.payload as { bookingReference: string }).bookingReference = BOOKING_REFERENCE;
    (event.payload as { passengerRef: string }).passengerRef = PASSENGER_REF;
    (event.payload as { tripId: string }).tripId = TRIP_ID;
    (event.payload as { coachNumber: number }).coachNumber = 1;
    (event.payload as { seatNumber: string }).seatNumber = '4';
    (event.payload as { paymentReference: string }).paymentReference = CHARGE_ID;

    // Inventory consumer releases the seat.
    const invUnitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(inventoryDs));
    const releaseService = new SoldSeatReleaseService(
      new (await import('../../apps/inventory/src/modules/seat-hold/hold-core.repository.js')).HoldCoreRepository(),
      invUnitOfWork,
    );
    const inventoryConsumer = new InventoryConsumer(releaseService);
    await expect(inventoryConsumer.handle(event)).resolves.toEqual({ status: 'handled' });
    const [occ] = await inventoryDs.query(`SELECT state FROM seat_occupation WHERE released_at IS NULL AND trip_id = $1`, [TRIP_ID]);
    // The released row drops out of the partial index; a held row may or may not exist.
    const releasedRows = await inventoryDs.query(`SELECT count(*)::int AS n FROM seat_occupation WHERE state = 'released' AND trip_id = $1`, [TRIP_ID]);
    expect(releasedRows[0].n).toBe(1);

    // Payment consumer requests the refund.
    const PaymentChargeEntity = (await import('../../apps/payment/src/modules/charges/entities/payment-charge.entity.js')).PaymentChargeEntity;
    const paymentRepo = new PaymentChargeRepository(paymentDs.getRepository(PaymentChargeEntity));
    const paymentService = new PaymentDoubleService(paymentRepo, {} as never, {} as never);
    const paymentConsumer = new PaymentConsumer(paymentRepo, paymentService);
    await expect(paymentConsumer.handle(event)).resolves.toEqual({ status: 'handled' });
    const [charge] = await paymentDs.query(`SELECT status, refund_amount_piastres FROM payment_charge WHERE id = $1`, [CHARGE_ID]);
    expect(charge.status).toBe('refunded');
    expect(Number(charge.refund_amount_piastres)).toBe(6500);

    // Email consumer sends one email.
    const sent: { to: string }[] = [];
    const emails = { send: async (e: { to: string }) => { sent.push(e); } };
    const recipients = { recipientFor: async () => ({ email: 'traveller@example.com', language: 'en' as const }) };
    const notificationConsumer = new NotificationConsumer(recipients as never, emails as never);
    await expect(notificationConsumer.handle(event)).resolves.toEqual({ status: 'handled' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('traveller@example.com');
  });

  it('duplicate delivery leaves the seat released and the refund recorded once', async () => {
    const ticketId = await issueTicket();
    const repo = new TicketCancellationRepository(bookingDs.getRepository(TicketEntity));
    const bookings = new BookingFlowRepository(bookingDs.getRepository(BookingDraftEntity), bookingDs.getRepository(TicketEntity));
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
    const outbox = new TypeOrmOutboxRepository(new DataSourceInitializer(bookingDs));
    const service = new TicketCancellationService(repo, bookings, uow, outbox, () => new Date());

    const preview = await service.preview(ticketId, OWNER);
    await service.confirm({ ticketId, tier: preview.tier, idempotencyKey: `ticket:${ticketId}:cancel` }, OWNER, 'corr-1');

    const [outboxRow] = await bookingDs.query(`SELECT event_type, event_version, payload, correlation_id, producer, occurred_at FROM outbox_event WHERE event_type = 'ticket.cancelled' ORDER BY id DESC LIMIT 1`);
    const payload = typeof outboxRow.payload === 'string' ? JSON.parse(outboxRow.payload) : outboxRow.payload;
    const event: EventEnvelope = {
      id: randomUUID(),
      type: outboxRow.event_type,
      version: outboxRow.event_version,
      occurredAt: outboxRow.occurred_at instanceof Date ? outboxRow.occurred_at.toISOString() : String(outboxRow.occurred_at),
      correlationId: outboxRow.correlation_id,
      producer: outboxRow.producer,
      payload,
    };
    (event.payload as { bookingReference: string }).bookingReference = BOOKING_REFERENCE;
    (event.payload as { passengerRef: string }).passengerRef = PASSENGER_REF;
    (event.payload as { tripId: string }).tripId = TRIP_ID;
    (event.payload as { coachNumber: number }).coachNumber = 1;
    (event.payload as { seatNumber: string }).seatNumber = '4';
    (event.payload as { paymentReference: string }).paymentReference = CHARGE_ID;

    const invUnitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(inventoryDs));
    const releaseService = new SoldSeatReleaseService(
      new (await import('../../apps/inventory/src/modules/seat-hold/hold-core.repository.js')).HoldCoreRepository(),
      invUnitOfWork,
    );
    const inventoryConsumer = new InventoryConsumer(releaseService);

    const PaymentChargeEntity = (await import('../../apps/payment/src/modules/charges/entities/payment-charge.entity.js')).PaymentChargeEntity;
    const paymentRepo = new PaymentChargeRepository(paymentDs.getRepository(PaymentChargeEntity));
    const paymentService = new PaymentDoubleService(paymentRepo, {} as never, {} as never);
    const paymentConsumer = new PaymentConsumer(paymentRepo, paymentService);

    await inventoryConsumer.handle(event);
    await inventoryConsumer.handle(event);
    await paymentConsumer.handle(event);
    await paymentConsumer.handle(event);

    const releasedRows = await inventoryDs.query(`SELECT count(*)::int AS n FROM seat_occupation WHERE state = 'released' AND trip_id = $1`, [TRIP_ID]);
    expect(releasedRows[0].n).toBe(1);
    const [charge] = await paymentDs.query(`SELECT status FROM payment_charge WHERE id = $1`, [CHARGE_ID]);
    expect(charge.status).toBe('refunded');
  });

  it('confirm succeeds and leaves a durable event even before consumers run (outage catch-up)', async () => {
    const ticketId = await issueTicket();
    const repo = new TicketCancellationRepository(bookingDs.getRepository(TicketEntity));
    const bookings = new BookingFlowRepository(bookingDs.getRepository(BookingDraftEntity), bookingDs.getRepository(TicketEntity));
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(bookingDs));
    const outbox = new TypeOrmOutboxRepository(new DataSourceInitializer(bookingDs));
    const service = new TicketCancellationService(repo, bookings, uow, outbox, () => new Date());

    const preview = await service.preview(ticketId, OWNER);
    const result = await service.confirm({ ticketId, tier: preview.tier, idempotencyKey: `ticket:${ticketId}:cancel` }, OWNER, 'corr-1');
    expect(result.status).toBe('CANCELLED');
    // Consumers deliberately not invoked here — cancellation must not depend on them.
    const events = await bookingDs.query(`SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'ticket.cancelled'`);
    expect(events[0].n).toBe(1);
    // Catch-up: running consumers afterwards settles the seat and refund.
    const [outboxRow] = await bookingDs.query(`SELECT event_type, event_version, payload, correlation_id, producer, occurred_at FROM outbox_event WHERE event_type = 'ticket.cancelled' ORDER BY id DESC LIMIT 1`);
    const payload = typeof outboxRow.payload === 'string' ? JSON.parse(outboxRow.payload) : outboxRow.payload;
    const event: EventEnvelope = {
      id: randomUUID(),
      type: outboxRow.event_type,
      version: outboxRow.event_version,
      occurredAt: outboxRow.occurred_at instanceof Date ? outboxRow.occurred_at.toISOString() : String(outboxRow.occurred_at),
      correlationId: outboxRow.correlation_id,
      producer: outboxRow.producer,
      payload,
    };
    (event.payload as { bookingReference: string }).bookingReference = BOOKING_REFERENCE;
    (event.payload as { passengerRef: string }).passengerRef = PASSENGER_REF;
    (event.payload as { tripId: string }).tripId = TRIP_ID;
    (event.payload as { coachNumber: number }).coachNumber = 1;
    (event.payload as { seatNumber: string }).seatNumber = '4';
    (event.payload as { paymentReference: string }).paymentReference = CHARGE_ID;

    const invUnitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(inventoryDs));
    const releaseService = new SoldSeatReleaseService(
      new (await import('../../apps/inventory/src/modules/seat-hold/hold-core.repository.js')).HoldCoreRepository(),
      invUnitOfWork,
    );
    const inventoryConsumer = new InventoryConsumer(releaseService);
    await inventoryConsumer.handle(event);

    const PaymentChargeEntity = (await import('../../apps/payment/src/modules/charges/entities/payment-charge.entity.js')).PaymentChargeEntity;
    const paymentRepo = new PaymentChargeRepository(paymentDs.getRepository(PaymentChargeEntity));
    const paymentService = new PaymentDoubleService(paymentRepo, {} as never, {} as never);
    const paymentConsumer = new PaymentConsumer(paymentRepo, paymentService);
    await paymentConsumer.handle(event);

    const releasedRows = await inventoryDs.query(`SELECT count(*)::int AS n FROM seat_occupation WHERE state = 'released' AND trip_id = $1`, [TRIP_ID]);
    expect(releasedRows[0].n).toBe(1);
    const [charge] = await paymentDs.query(`SELECT status FROM payment_charge WHERE id = $1`, [CHARGE_ID]);
    expect(charge.status).toBe('refunded');
  });
});