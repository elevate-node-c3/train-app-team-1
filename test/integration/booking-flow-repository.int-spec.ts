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

describe('BookingFlowRepository.deferSaga', () => {
  it('persists failure counts and capped exponential backoff for the current lease owner', async () => {
    const worker = randomUUID();
    await seed(BOOKING, {
      flowState: 'refunding',
      paymentSucceededAt: secondsAgo(90),
    });
    await ds.query(`UPDATE booking_draft SET lease_owner = $2 WHERE id = $1`, [
      BOOKING,
      worker,
    ]);
    expect(await repository.deferSaga(BOOKING, worker, 'refund refused')).toBe(
      1,
    );
    const [first] = await ds.query(
      `SELECT saga_attempts,
      EXTRACT(EPOCH FROM (resume_next_attempt_at - updated_at)) AS delay,
      lease_owner, compensation_last_error FROM booking_draft WHERE id = $1`,
      [BOOKING],
    );
    expect(first.saga_attempts).toBe(1);
    expect(Number(first.delay)).toBe(2);
    expect(first.lease_owner).toBeNull();
    expect(first.compensation_last_error).toBe('refund refused');

    await ds.query(
      `UPDATE booking_draft SET lease_owner = $2, saga_attempts = 11 WHERE id = $1`,
      [BOOKING, worker],
    );
    expect(
      await repository.deferSaga(BOOKING, randomUUID(), 'stale attempt'),
    ).toBeNull();
    expect(await repository.deferSaga(BOOKING, worker, 'still refused')).toBe(
      12,
    );
    const [last] = await ds.query(
      `SELECT EXTRACT(EPOCH FROM
      (resume_next_attempt_at - updated_at)) AS delay FROM booking_draft WHERE id = $1`,
      [BOOKING],
    );
    expect(Number(last.delay)).toBe(60);
  });
});
