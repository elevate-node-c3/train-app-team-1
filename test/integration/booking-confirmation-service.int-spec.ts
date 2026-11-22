import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { TypeOrmOutboxRepository } from '@app/messaging';
import type { SettlementSnapshot } from '@app/contracts';

import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../../apps/booking/src/modules/flow/entities/ticket.entity.js';
import { BookingFlowRepository } from '../../apps/booking/src/modules/flow/booking-flow.repository.js';
import type { FlowGrpcClientsService } from '../../apps/booking/src/modules/flow/services/flow-grpc-clients.service.js';
import { TicketIssuerService } from '../../apps/booking/src/modules/flow/services/ticket-issuer.service.js';
import { BookingConfirmationService } from '../../apps/booking/src/modules/flow/services/booking-confirmation.service.js';
import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';

const BOOKING = randomUUID();
const OWNER = randomUUID();
const OUTBOUND = randomUUID();
const RETURN = randomUUID();

let ds: DataSource;
let repository: BookingFlowRepository;
let service: BookingConfirmationService;
let inventory: { settleHold: ReturnType<typeof vi.fn> };
let payment: { refundCharge: ReturnType<typeof vi.fn> };

function settled(
  outcome: 'SOLD' | 'REALLOCATED' | 'NO_SEATS',
  assignments: SettlementSnapshot['assignments'] = [],
): SettlementSnapshot {
  return {
    outcome,
    holdId: randomUUID(),
    legs: [],
    assignments,
    serverNow: new Date().toISOString(),
  };
}

async function given(props: {
  settlementOutcome?: 'sold' | 'reallocated' | 'no_seats';
  seatsChanged?: boolean;
  sagaStep: string;
  passengers?: string[];
  legs?: string[];
  totalPiastres?: number;
}): Promise<void> {
  const passengers = props.passengers ?? ['p1'];
  const legs = props.legs ?? [OUTBOUND];
  const passengerSnapshot = passengers.map((ref) => ({
    passengerRef: ref,
    displayName: ref,
    maskedNationalId: '***',
    identities: [],
  }));
  const settledSeats = passengers.flatMap((ref, passengerIndex) =>
    legs.map((tripId, legIndex) => ({
      passengerRef: ref,
      tripId,
      coachNumber: 1,
      seatNumber: `${passengerIndex + 1}${String.fromCharCode(65 + legIndex)}`,
    })),
  );

  await ds.query(
    `UPDATE booking_draft
        SET saga_step = $2, settlement_outcome = $3, seats_changed = $4,
            total_piastres = $5, passenger_snapshot = $6::jsonb,
            settled_seats = $7::jsonb
      WHERE id = $1`,
    [
      BOOKING,
      props.sagaStep,
      props.settlementOutcome ?? null,
      props.seatsChanged ?? false,
      props.totalPiastres ?? 6955,
      JSON.stringify(passengerSnapshot),
      JSON.stringify(settledSeats),
    ],
  );
}

async function read(bookingReference: string) {
  const [row] = await ds.query(
    `SELECT flow_state, status, total_piastres, settlement_outcome, saga_step
       FROM booking_draft WHERE id = $1`,
    [bookingReference],
  );
  return row as {
    flow_state: string;
    status: string;
    total_piastres: number;
    settlement_outcome: string | null;
    saga_step: string | null;
  };
}

async function ticketCount(bookingReference: string): Promise<number> {
  const [row]: { count: string }[] = await ds.query(
    `SELECT count(*)::text AS count FROM ticket WHERE booking_reference = $1`,
    [bookingReference],
  );
  return Number(row.count);
}

async function outboxEventTypes(): Promise<string[]> {
  const rows: { event_type: string }[] = await ds.query(
    `SELECT event_type FROM outbox_event ORDER BY occurred_at, event_type`,
  );
  return rows.map((row) => row.event_type);
}

async function outboxRow(
  eventType: string,
): Promise<{ payload: Record<string, unknown> }> {
  const [row] = await ds.query(
    `SELECT payload FROM outbox_event WHERE event_type = $1`,
    [eventType],
  );
  return row as { payload: Record<string, unknown> };
}

beforeEach(async () => {
  ds = await bookingDataSource();
  await truncateBooking(ds);

  await ds.query(
    `INSERT INTO booking_draft
       (id, user_id, flow_state, status, saga_step, total_piastres,
        payment_reference, correlation_id)
     VALUES ($1, $2, 'confirming', 'PENDING', 'payment_recorded', 6955, $3, 'corr-1')`,
    [BOOKING, OWNER, randomUUID()],
  );

  repository = new BookingFlowRepository(
    ds.getRepository(BookingDraftEntity),
    ds.getRepository(TicketEntity),
  );
  const initializer = new DataSourceInitializer(ds);
  const unitOfWork = new TypeOrmUnitOfWork(initializer);
  const outbox = new TypeOrmOutboxRepository(initializer);
  const ticketIssuer = new TicketIssuerService();

  inventory = { settleHold: vi.fn() };
  payment = {
    refundCharge: vi.fn().mockResolvedValue({
      status: 'REFUNDED',
      refundReference: 'refund_1',
      amountPiastres: 6955,
    }),
  };
  const clients = {
    settleHold: inventory.settleHold,
    refundCharge: payment.refundCharge,
  } as unknown as FlowGrpcClientsService;

  service = new BookingConfirmationService(
    repository,
    clients,
    ticketIssuer,
    unitOfWork,
    outbox,
  );
});

afterAll(async () => {
  await closeBookingDataSource();
});

describe('BookingConfirmationService.run', () => {
  it('records what inventory decided before it issues anything', async () => {
    inventory.settleHold.mockResolvedValue(settled('SOLD'));
    await service.run(BOOKING);
    const row = await read(BOOKING);
    expect(row.settlement_outcome).toBe('sold');
    expect(row.saga_step).toBe('settled');
    expect(await ticketCount(BOOKING)).toBe(0);
  });

  it('issues one ticket per passenger per leg and confirms, in one transaction', async () => {
    await given({
      settlementOutcome: 'sold',
      sagaStep: 'settled',
      passengers: ['p1', 'p2'],
      legs: [OUTBOUND, RETURN],
    });
    await service.run(BOOKING);
    const row = await read(BOOKING);
    expect(row.flow_state).toBe('confirmed');
    expect(row.status).toBe('CONFIRMED');
    expect(await ticketCount(BOOKING)).toBe(4);
    expect(await outboxEventTypes()).toEqual(['booking.confirmed']);
  });

  it('publishes seats-changed as well when the seats moved', async () => {
    await given({
      settlementOutcome: 'reallocated',
      seatsChanged: true,
      sagaStep: 'settled',
    });
    await service.run(BOOKING);
    expect(await outboxEventTypes()).toEqual(
      expect.arrayContaining(['booking.confirmed', 'booking.seats-changed']),
    );
  });

  it('leaves the fare alone when the seats changed', async () => {
    await given({
      settlementOutcome: 'reallocated',
      seatsChanged: true,
      sagaStep: 'settled',
      totalPiastres: 6955,
    });
    await service.run(BOOKING);
    expect((await read(BOOKING)).total_piastres).toBe(6955);
  });

  it('refunds the whole total including the fee when there are no seats', async () => {
    await given({
      settlementOutcome: 'no_seats',
      sagaStep: 'settled',
      totalPiastres: 6955,
    });
    await service.run(BOOKING); // begins refunding
    await service.run(BOOKING); // calls payment
    expect(payment.refundCharge).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `booking:${BOOKING}:refund` }),
    );
    const row = await read(BOOKING);
    expect(row.flow_state).toBe('refunded');
    expect(row.status).toBe('CANCELLED');
    expect(await ticketCount(BOOKING)).toBe(0);
    const refunded = await outboxRow('booking.refunded');
    expect(refunded.payload.amountPiastres).toBe(6955);
  });

  it('issues one set of tickets when the confirm step runs twice', async () => {
    await given({
      settlementOutcome: 'sold',
      sagaStep: 'settled',
      passengers: ['p1'],
    });
    await service.run(BOOKING);
    await service.run(BOOKING);
    expect(await ticketCount(BOOKING)).toBe(1);
    expect(await outboxEventTypes()).toEqual(['booking.confirmed']);
  });

  it('keeps the refund owed and retries when payment refuses', async () => {
    payment.refundCharge.mockRejectedValueOnce(new Error('Stripe is down'));
    await given({ settlementOutcome: 'no_seats', sagaStep: 'settled' });
    await service.run(BOOKING);
    await expect(service.run(BOOKING)).rejects.toThrow();
    expect((await read(BOOKING)).flow_state).toBe('refunding');
  });
});
