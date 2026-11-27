import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { PermanentEventError } from '@app/messaging/event-errors.js';

import { HoldCoreRepository } from '../../apps/inventory/src/modules/seat-hold/hold-core.repository.js';
import { SoldSeatReleaseService } from '../../apps/inventory/src/modules/seat-hold/services/sold-seat-release.service.js';
import { TicketCancelledConsumer } from '../../apps/inventory/src/modules/seat-hold/consumers/ticket-cancelled.consumer.js';
import { seedSixStopTrip } from './support/inventory-fixture.js';
import {
  closeInventoryDataSource,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import {
  occupationState,
  seedSoldSeat,
  ticketCancelled,
} from './support/sold-seat-fixture.js';

const BOOKING_REFERENCE = `consumer-${randomUUID()}`;

let source: DataSource;
let consumer: TicketCancelledConsumer;

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);
  await seedSixStopTrip(source);
  consumer = new TicketCancelledConsumer(
    new SoldSeatReleaseService(
      new HoldCoreRepository(),
      new TypeOrmUnitOfWork(new DataSourceInitializer(source)),
    ),
  );
});

afterAll(async () => {
  await closeInventoryDataSource();
});

describe('Inventory TicketCancelledConsumer (real PostgreSQL)', () => {
  it('releases the passenger\'s sold seat and handles a redelivery', async () => {
    const { occupationId } = await seedSoldSeat(source, {
      bookingReference: BOOKING_REFERENCE,
      passengerRef: 'passenger-a',
      from: 0,
      to: 2,
    });
    const event = ticketCancelled({
      bookingReference: BOOKING_REFERENCE,
      passengerRef: 'passenger-a',
    });

    await expect(consumer.handle(event)).resolves.toEqual({ status: 'handled' });
    const released = await occupationState(source, occupationId);
    expect(released.state).toBe('released');
    expect(released.releasedAt).not.toBeNull();

    await expect(consumer.handle(event)).resolves.toEqual({ status: 'handled' });
    expect(await occupationState(source, occupationId)).toEqual(released);
  });

  it('rejects a malformed payload with a permanent error', async () => {
    const event = ticketCancelled({
      bookingReference: BOOKING_REFERENCE,
      passengerRef: 'passenger-a',
    });
    event.payload = { ...event.payload, coachNumber: 0 };

    await expect(consumer.handle(event)).rejects.toBeInstanceOf(
      PermanentEventError,
    );
  });
});
