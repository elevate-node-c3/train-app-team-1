import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { ErrorCode } from '@app/contracts';
import { TypeOrmOutboxRepository } from '@app/messaging';

import { BookingFlowFault } from '../../apps/booking/src/modules/flow/booking-flow-error.js';
import { BookingFlowRepository } from '../../apps/booking/src/modules/flow/booking-flow.repository.js';
import { TicketEntity } from '../../apps/booking/src/modules/flow/entities/ticket.entity.js';
import { TicketCancellationRepository } from '../../apps/booking/src/modules/flow/services/ticket-cancellation.repository.js';
import { TicketCancellationService } from '../../apps/booking/src/modules/flow/services/ticket-cancellation.service.js';
import { TicketIssuerService } from '../../apps/booking/src/modules/flow/services/ticket-issuer.service.js';
import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';
import {
  TEST_MASKED_NATIONAL_ID,
  TEST_TRAVEL_CLASS,
  testQuotedLeg,
  testTicketSigner,
} from './support/ticket-fixture.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE_NOW = new Date('2026-11-27T10:00:00.000Z');
const FARE = 15_500;
const PAYMENT_REFERENCE = randomUUID();

let ds: DataSource;
let unitOfWork: TypeOrmUnitOfWork;
let service: TicketCancellationService;
let now: Date;
const owner = randomUUID();

/** An issued ticket on a real draft with a charge reference. */
async function issue(props: {
  owner: string;
  departsAt: Date;
  farePiastres?: number;
  paymentReference?: string | null;
}): Promise<{ bookingReference: string; ticketId: string; tripId: string }> {
  const bookingReference = randomUUID();
  const leg = testQuotedLeg(randomUUID(), {
    farePiastres: props.farePiastres ?? FARE,
  });
  await ds.query(
    `INSERT INTO booking_draft (id, user_id, payment_reference)
      VALUES ($1, $2, $3)`,
    [
      bookingReference,
      props.owner,
      props.paymentReference === undefined
        ? PAYMENT_REFERENCE
        : props.paymentReference,
    ],
  );

  const draft = Object.assign(new BookingDraftEntity(), {
    id: bookingReference,
    userId: props.owner,
    travelClass: TEST_TRAVEL_CLASS,
    quotedLegs: [leg],
    passengerSnapshot: [
      {
        passengerRef: 'passenger-1',
        displayName: 'Omar Khaled',
        maskedNationalId: TEST_MASKED_NATIONAL_ID,
        identities: [],
      },
    ],
    settledSeats: [
      {
        passengerRef: 'passenger-1',
        tripId: leg.tripId,
        coachNumber: 1,
        seatNumber: '12A',
      },
    ],
  });
  const tickets = await unitOfWork.withTransaction((ctx) =>
    new TicketIssuerService(testTicketSigner()).issue(ctx, draft),
  );

  // The policy reads the ticket's own instant, not the timetable's.
  await ds.query(`UPDATE ticket SET departs_at = $2 WHERE id = $1`, [
    tickets[0].id,
    props.departsAt.toISOString(),
  ]);
  return {
    bookingReference,
    ticketId: tickets[0].id,
    tripId: tickets[0].tripId,
  };
}

async function ticketRow(id: string) {
  const [row] = await ds.query(
    `SELECT status, status_reason, refund_status, refund_piastres,
            cancellation_idempotency_key
       FROM ticket WHERE id = $1`,
    [id],
  );
  return row as {
    status: string;
    status_reason: string | null;
    refund_status: string | null;
    refund_piastres: number | null;
    cancellation_idempotency_key: string | null;
  };
}

async function cancelledEvents(ticketId: string) {
  const rows = await ds.query(
    `SELECT event_type, payload FROM outbox_event
      WHERE event_type = 'ticket.cancelled'
        AND payload->>'ticketId' = $1`,
    [ticketId],
  );
  return rows as { event_type: string; payload: Record<string, unknown> }[];
}

function request(
  ticketId: string,
  key: string,
  tier: 'FULL' | 'HALF' = 'HALF',
) {
  return { ticketId, tier, idempotencyKey: key };
}

beforeEach(async () => {
  ds = await bookingDataSource();
  await truncateBooking(ds);
  now = BASE_NOW;

  const initializer = new DataSourceInitializer(ds);
  unitOfWork = new TypeOrmUnitOfWork(initializer);
  service = new TicketCancellationService(
    new TicketCancellationRepository(ds.getRepository(TicketEntity)),
    new BookingFlowRepository(
      ds.getRepository(BookingDraftEntity),
      ds.getRepository(TicketEntity),
    ),
    unitOfWork,
    new TypeOrmOutboxRepository(initializer),
    () => now,
  );
});

afterAll(async () => {
  await closeBookingDataSource();
});

describe('TicketCancellationService', () => {
  it('previews 50% for a ticket 6 hours from boarding, no mutation', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
    });

    await expect(service.preview(ticketId, owner)).resolves.toEqual({
      allowed: true,
      tier: 'HALF',
      refundPiastres: 7750,
      code: '',
    });
    expect(await ticketRow(ticketId)).toEqual({
      status: 'active',
      status_reason: null,
      refund_status: null,
      refund_piastres: null,
      cancellation_idempotency_key: null,
    });
    expect(await cancelledEvents(ticketId)).toHaveLength(0);
  });

  it('confirms at the previewed tier and publishes ticket.cancelled', async () => {
    const { ticketId, bookingReference, tripId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
    });
    const preview = await service.preview(ticketId, owner);

    await expect(
      service.confirm(
        request(ticketId, `ticket:${ticketId}:cancel`, preview.tier as 'HALF'),
        owner,
        'corr-cancel-1',
      ),
    ).resolves.toEqual({ status: 'CANCELLED', refundPiastres: 7750 });

    expect(await ticketRow(ticketId)).toMatchObject({
      status: 'cancelled',
      status_reason: 'TRAVELLER_CANCELLED',
      refund_status: 'pending',
      refund_piastres: 7750,
      cancellation_idempotency_key: `ticket:${ticketId}:cancel`,
    });
    const events = await cancelledEvents(ticketId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      ticketId,
      bookingReference,
      passengerRef: 'passenger-1',
      tripId,
      coachNumber: 1,
      seatNumber: '12A',
      accountId: owner,
      refundPiastres: 7750,
      paymentReference: PAYMENT_REFERENCE,
    });
  });

  it('refuses CANCELLATION_OUTCOME_CHANGED when the boundary was crossed between preview and confirm', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + DAY + 2_000),
    });
    await expect(service.preview(ticketId, owner)).resolves.toMatchObject({
      allowed: true,
      tier: 'FULL',
      refundPiastres: FARE,
    });

    now = new Date(now.getTime() + 5_000);

    await expect(
      service.confirm(
        request(ticketId, `ticket:${ticketId}:cancel`, 'FULL'),
        owner,
        'corr-2',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CANCELLATION_OUTCOME_CHANGED });
    expect((await ticketRow(ticketId)).status).toBe('active');
    expect(await cancelledEvents(ticketId)).toHaveLength(0);
  });

  it('returns the original response on a replayed idempotency key (BR-47)', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
    });
    const key = `ticket:${ticketId}:cancel`;
    const first = await service.confirm(
      request(ticketId, key),
      owner,
      'corr-3',
    );
    const replay = await service.confirm(
      request(ticketId, key),
      owner,
      'corr-4',
    );

    expect(replay).toEqual(first);
    expect(await cancelledEvents(ticketId)).toHaveLength(1);
  });

  it('answers ALREADY_CANCELLED for a different idempotency key on an already-cancelled ticket', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
    });
    await service.confirm(request(ticketId, 'key-one'), owner, 'corr-5');

    await expect(
      service.confirm(request(ticketId, 'key-two'), owner, 'corr-6'),
    ).rejects.toMatchObject({ code: ErrorCode.TICKET_ALREADY_CANCELLED });
    expect(await cancelledEvents(ticketId)).toHaveLength(1);
  });

  it('proves cancel-once under concurrency: two confirmations for the same ticket at the same instant produce exactly one cancellation and one outbox row', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
    });

    const outcomes = await Promise.allSettled([
      service.confirm(request(ticketId, 'race-one'), owner, 'corr-race-1'),
      service.confirm(request(ticketId, 'race-two'), owner, 'corr-race-2'),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({
      value: { status: 'CANCELLED', refundPiastres: 7750 },
    });
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({
        code: ErrorCode.TICKET_ALREADY_CANCELLED,
      });
    }
    expect((await ticketRow(ticketId)).status).toBe('cancelled');
    expect(await cancelledEvents(ticketId)).toHaveLength(1);
  });

  it("404s on another traveller's ticket", async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
    });
    const stranger = randomUUID();
    const key = `ticket:${ticketId}:cancel`;

    await expect(service.preview(ticketId, stranger)).rejects.toMatchObject({
      code: ErrorCode.RESOURCE_NOT_FOUND,
    });
    await expect(
      service.confirm(request(ticketId, key), stranger, 'corr-stranger'),
    ).rejects.toMatchObject({ code: ErrorCode.RESOURCE_NOT_FOUND });
    // A replay of someone else's key must not cancel or expose that ticket.
    expect((await ticketRow(ticketId)).status).toBe('active');
    expect(await cancelledEvents(ticketId)).toHaveLength(0);
  });

  it('refuses an already-cancelled ticket with TICKET_ALREADY_CANCELLED on preview', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
    });
    await service.confirm(request(ticketId, 'key-one'), owner, 'corr-7');

    await expect(service.preview(ticketId, owner)).rejects.toMatchObject({
      code: ErrorCode.TICKET_ALREADY_CANCELLED,
    });
  });

  it('rolls back the cancellation when the booking charge reference is missing', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() + 6 * HOUR),
      paymentReference: null,
    });

    await expect(
      service.confirm(request(ticketId, 'key-no-payment'), owner, 'corr-fault'),
    ).rejects.toBeInstanceOf(BookingFlowFault);
    expect(await ticketRow(ticketId)).toMatchObject({ status: 'active' });
    expect(await cancelledEvents(ticketId)).toHaveLength(0);
  });

  it('refuses CANCELLATION_WINDOW_CLOSED for a departed ticket', async () => {
    const { ticketId } = await issue({
      owner,
      departsAt: new Date(now.getTime() - HOUR),
    });

    await expect(service.preview(ticketId, owner)).resolves.toEqual({
      allowed: false,
      tier: '',
      refundPiastres: 0,
      code: ErrorCode.CANCELLATION_WINDOW_CLOSED,
    });
    await expect(
      service.confirm(
        request(ticketId, 'key-departed', 'HALF'),
        owner,
        'corr-8',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CANCELLATION_WINDOW_CLOSED });
    expect((await ticketRow(ticketId)).status).toBe('active');
    expect(await cancelledEvents(ticketId)).toHaveLength(0);
  });
});
