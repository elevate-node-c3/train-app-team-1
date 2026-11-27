import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';

import { HoldCoreRepository } from '../../apps/inventory/src/modules/seat-hold/hold-core.repository.js';
import { SoldSeatReleaseService } from '../../apps/inventory/src/modules/seat-hold/services/sold-seat-release.service.js';
import {
  occupy,
  seedSixStopTrip,
} from './support/inventory-fixture.js';
import {
  closeInventoryDataSource,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import {
  occupationState,
  seedSoldSeat,
} from './support/sold-seat-fixture.js';

const TRIP_ID = '10000000-0000-4000-8000-000000000001';
const BOOKING_REFERENCE = `release-${randomUUID()}`;
const OTHER_BOOKING_REFERENCE = `other-segment-${randomUUID()}`;

let source: DataSource;
let service: SoldSeatReleaseService;

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);
  await seedSixStopTrip(source);
  service = new SoldSeatReleaseService(
    new HoldCoreRepository(),
    new TypeOrmUnitOfWork(new DataSourceInitializer(source)),
  );
});

afterAll(async () => {
  await closeInventoryDataSource();
});

describe('SoldSeatReleaseService (real PostgreSQL)', () => {
  it('frees exactly the cancelled seat on its segment, leaving the same seat on a different segment sold', async () => {
    const released = await seedSoldSeat(source, {
      bookingReference: BOOKING_REFERENCE,
      passengerRef: 'passenger-a',
      from: 0,
      to: 2,
    });
    const untouched = await seedSoldSeat(source, {
      bookingReference: OTHER_BOOKING_REFERENCE,
      passengerRef: 'passenger-b',
      from: 2,
      to: 5,
    });

    await expect(
      service.release({
        bookingReference: BOOKING_REFERENCE,
        passengerRef: 'passenger-a',
        tripId: TRIP_ID,
        coachNumber: 1,
        seatNumber: '4',
      }),
    ).resolves.toBe('RELEASED');

    expect(await occupationState(source, released.occupationId)).toMatchObject({
      state: 'released',
    });
    expect((await occupationState(source, released.occupationId)).releasedAt).not.toBeNull();
    expect(await occupationState(source, untouched.occupationId)).toMatchObject({
      state: 'sold',
      releasedAt: null,
    });
  });

  it('is idempotent: a second release reports ALREADY_RELEASED without changing released_at', async () => {
    const { occupationId } = await seedSoldSeat(source, {
      bookingReference: BOOKING_REFERENCE,
      passengerRef: 'passenger-a',
      from: 0,
      to: 2,
    });
    const input = {
      bookingReference: BOOKING_REFERENCE,
      passengerRef: 'passenger-a',
      tripId: TRIP_ID,
      coachNumber: 1,
      seatNumber: '4',
    };

    expect(await service.release(input)).toBe('RELEASED');
    const first = await occupationState(source, occupationId);

    expect(await service.release(input)).toBe('ALREADY_RELEASED');
    const second = await occupationState(source, occupationId);
    expect(second.state).toBe('released');
    expect(second.releasedAt).toEqual(first.releasedAt);
  });

  it('lets another traveller hold the freed segment immediately after release', async () => {
    const { occupationId, tripSeatId } = await seedSoldSeat(source, {
      bookingReference: BOOKING_REFERENCE,
      passengerRef: 'passenger-a',
      from: 0,
      to: 2,
    });

    await expect(
      service.release({
        bookingReference: BOOKING_REFERENCE,
        passengerRef: 'passenger-a',
        tripId: TRIP_ID,
        coachNumber: 1,
        seatNumber: '4',
      }),
    ).resolves.toBe('RELEASED');
    expect((await occupationState(source, occupationId)).releasedAt).not.toBeNull();

    // The live exclusion constraint is the real proof: inserting a new held
    // occupation over the same range would fail while the sold row is live.
    await expect(
      occupy(
        source,
        tripSeatId,
        TRIP_ID,
        { from: 0, to: 2 },
        'held',
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toBeTruthy();
    expect(
      await source.query(
        `SELECT state FROM seat_occupation
          WHERE trip_seat_id = $1 AND released_at IS NULL`,
        [tripSeatId],
      ),
    ).toEqual([{ state: 'held' }]);
  });

  it('reports ALREADY_RELEASED when no matching sold seat exists', async () => {
    await expect(
      service.release({
        bookingReference: 'unknown-booking',
        passengerRef: 'nobody',
        tripId: TRIP_ID,
        coachNumber: 1,
        seatNumber: '4',
      }),
    ).resolves.toBe('ALREADY_RELEASED');
  });
});
