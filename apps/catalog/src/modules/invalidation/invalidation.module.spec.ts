import { describe, expect, it } from 'vitest';

import type { EventHandlerPort } from '@app/messaging/consumer/event-handler.port.js';

import {
  CATALOG_INVALIDATION_QUEUES,
  createCatalogInvalidationSubscriptions,
} from './invalidation.module.js';

const handler = {
  handle: async () => ({ status: 'handled' as const }),
} satisfies EventHandlerPort;

describe('catalog invalidation subscriptions', () => {
  const subscriptions = createCatalogInvalidationSubscriptions(handler);

  it('gives every event type its own queue', () => {
    // A subscription validates a delivery against its own eventType, so four
    // subscriptions on one queue would take turns receiving each other's
    // events and dead-letter three in four as invalid-payload.
    const queues = subscriptions.map((s) => s.queueName);

    expect(new Set(queues).size).toBe(subscriptions.length);
    expect(queues.sort()).toEqual([...CATALOG_INVALIDATION_QUEUES].sort());
  });

  it('subscribes to the four event types CAT-5 invalidates on', () => {
    expect(subscriptions.map((s) => s.eventType).sort()).toEqual([
      'catalog.fare.changed',
      'catalog.station.changed',
      'catalog.timetable.published',
      'inventory.seat.availability-changed',
    ]);
  });

  it('names each queue after the event it carries', () => {
    for (const subscription of subscriptions) {
      // catalog.fare.changed -> catalog.invalidation.fare-changed
      const tail = subscription.eventType.split('.').slice(1).join('-');

      expect(subscription.queueName).toBe(`catalog.invalidation.${tail}`);
    }
  });

  it('pins a version on every subscription', () => {
    // An unversioned subscription would accept a payload shape it cannot read.
    for (const subscription of subscriptions) {
      expect(Number.isInteger(subscription.version)).toBe(true);
      expect(subscription.version).toBeGreaterThan(0);
    }
  });

  it('routes every queue to the one handler', () => {
    for (const subscription of subscriptions) {
      expect(subscription.handler).toBe(handler);
    }
  });
});
