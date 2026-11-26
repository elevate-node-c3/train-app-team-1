import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';

import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { TicketIssuerService } from '../../apps/booking/src/modules/flow/services/ticket-issuer.service.js';
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

let ds: DataSource;
let unitOfWork: TypeOrmUnitOfWork;
let issuer: TicketIssuerService;

function draftFor(id: string): BookingDraftEntity {
  const tripId = randomUUID();
  return Object.assign(new BookingDraftEntity(), {
    id,
    userId: randomUUID(),
    // Locked at the quote on every real draft; the ticket prints from them.
    travelClass: TEST_TRAVEL_CLASS,
    quotedLegs: [testQuotedLeg(tripId)],
    passengerSnapshot: [
      {
        passengerRef: 'p1',
        displayName: 'P1',
        maskedNationalId: TEST_MASKED_NATIONAL_ID,
        identities: [],
      },
    ],
    settledSeats: [
      {
        passengerRef: 'p1',
        tripId,
        coachNumber: 1,
        seatNumber: '1A',
      },
    ],
  });
}

beforeEach(async () => {
  ds = await bookingDataSource();
  await truncateBooking(ds);
  const initializer = new DataSourceInitializer(ds);
  unitOfWork = new TypeOrmUnitOfWork(initializer);
  issuer = new TicketIssuerService(testTicketSigner());
});

afterAll(async () => {
  await closeBookingDataSource();
});

async function seedDraftRow(id: string): Promise<void> {
  await ds.query(`INSERT INTO booking_draft (id, user_id) VALUES ($1, $2)`, [
    id,
    randomUUID(),
  ]);
}

describe('TicketIssuerService.issue', () => {
  it('does not collide on ticket_number across two different bookings', async () => {
    const bookingA = randomUUID();
    const bookingB = randomUUID();
    await seedDraftRow(bookingA);
    await seedDraftRow(bookingB);

    await unitOfWork.withTransaction((ctx) =>
      issuer.issue(ctx, draftFor(bookingA)),
    );
    await expect(
      unitOfWork.withTransaction((ctx) =>
        issuer.issue(ctx, draftFor(bookingB)),
      ),
    ).resolves.toBeDefined();

    const [row]: { count: string }[] = await ds.query(
      `SELECT count(*)::text AS count FROM ticket`,
    );
    expect(row.count).toBe('2');
  });
});
