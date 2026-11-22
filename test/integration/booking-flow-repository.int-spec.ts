import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import type { BookingFlowState } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../../apps/booking/src/modules/flow/entities/ticket.entity.js';
import { BookingFlowRepository } from '../../apps/booking/src/modules/flow/booking-flow.repository.js';
import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';

const BOOKING = randomUUID();
const OTHER = randomUUID();

let ds: DataSource;
let repository: BookingFlowRepository;

function secondsAgo(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

async function seed(
  id: string,
  props: {
    flowState: BookingFlowState;
    paymentSucceededAt: Date;
    sagaStep?: string;
  },
): Promise<void> {
  await ds.query(
    `INSERT INTO booking_draft
       (id, user_id, flow_state, payment_succeeded_at, saga_step)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      randomUUID(),
      props.flowState,
      props.paymentSucceededAt,
      props.sagaStep ?? null,
    ],
  );
}

beforeEach(async () => {
  ds = await bookingDataSource();
  await truncateBooking(ds);
  repository = new BookingFlowRepository(
    ds.getRepository(BookingDraftEntity),
    ds.getRepository(TicketEntity),
  );
});

afterAll(async () => {
  await closeBookingDataSource();
});

describe('BookingFlowRepository.findChargedWithoutOutcome', () => {
  it('lists a saga that has been charged but unsettled for longer than a minute', async () => {
    await seed(BOOKING, {
      flowState: 'confirming',
      paymentSucceededAt: secondsAgo(90),
      sagaStep: 'settled',
    });

    expect(await repository.findChargedWithoutOutcome(60)).toEqual([
      { id: BOOKING, sagaStep: 'settled' },
    ]);
  });

  it('lists neither a confirmed nor a refunded booking', async () => {
    await seed(BOOKING, {
      flowState: 'confirmed',
      paymentSucceededAt: secondsAgo(90),
    });
    await seed(OTHER, {
      flowState: 'refunded',
      paymentSucceededAt: secondsAgo(90),
    });

    expect(await repository.findChargedWithoutOutcome(60)).toEqual([]);
  });

  it('does not list a charge still within the threshold', async () => {
    await seed(BOOKING, {
      flowState: 'confirming',
      paymentSucceededAt: secondsAgo(10),
      sagaStep: 'payment_recorded',
    });

    expect(await repository.findChargedWithoutOutcome(60)).toEqual([]);
  });
});
