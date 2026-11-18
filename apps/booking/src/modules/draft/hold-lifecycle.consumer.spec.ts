import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOLD_EXPIRED_EVENT_TYPE,
  HOLD_EXTENDED_EVENT_TYPE,
  HOLD_HELD_EVENT_TYPE,
  HOLD_RELEASED_EVENT_TYPE,
  type HoldLifecyclePayloadV1,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';
import { consumerTopology } from '@app/messaging/amqp-topology.js';
import { BookingDraftService } from './booking-draft.service.js';
import {
  BookingHoldLifecycleConsumer,
  createHoldLifecycleSubscriptions,
} from './hold-lifecycle.consumer.js';
import { parseHoldLifecycleEvent } from './hold-lifecycle.parser.js';
import {
  createRequest,
  draftInput,
  holdEvent,
  inventorySnapshot,
  memoryDraftStore,
  resolvedPassengers,
} from './testing/hold-fixtures.js';

describe('Booking hold lifecycle consumer', () => {
  let memory: ReturnType<typeof memoryDraftStore>;
  let consumer: BookingHoldLifecycleConsumer;
  let reconcileHold: ReturnType<typeof vi.fn>;
  const dto = draftInput();
  const held = inventorySnapshot(createRequest(dto));

  beforeEach(async () => {
    memory = memoryDraftStore();
    await memory.store.createIntent(
      dto.bookingKey,
      dto.userId,
      'f'.repeat(64),
      { legs: dto.legs!, passengerRefs: dto.passengerIds },
    );
    await memory.store.rememberPassengers(
      dto.bookingKey,
      dto.userId,
      resolvedPassengers({
        ownerId: dto.userId,
        passengerRefs: dto.passengerIds,
        tripIds: dto.legs!.map((leg) => leg.tripId),
      }).passengers,
    );
    reconcileHold = vi.fn(async () => {
      expect(memory.isLocked()).toBe(false);
      await memory.store.applySnapshot(held);
    });
    consumer = new BookingHoldLifecycleConsumer(memory.store, {
      reconcileHold,
    } as unknown as BookingDraftService);
  });

  it('uses four distinct durable queues, each with the exact event binding', () => {
    const subscriptions = createHoldLifecycleSubscriptions(consumer);
    expect(subscriptions).toHaveLength(4);
    expect(
      new Set(subscriptions.map((subscription) => subscription.queueName)).size,
    ).toBe(4);
    for (const subscription of subscriptions) {
      const topology = consumerTopology({
        queue: subscription.queueName,
        eventType: subscription.eventType,
        retryDelaysMs: [100],
      });
      expect(topology.queues[0]).toMatchObject({
        durable: true,
        autoDelete: false,
        bindings: expect.arrayContaining([
          { exchange: 'train.events', routingKey: subscription.eventType },
        ]),
      });
    }
  });

  it('reconciles held receipts after the atomic event update without networking under its lock', async () => {
    await consumer.handle(holdEvent(held));
    expect(reconcileHold).toHaveBeenCalledOnce();
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      holdState: 'HELD',
      holdVersion: 1,
      reconciliationPending: false,
    });
    expect(memory.rows.get(dto.bookingKey)!.legs[0].assignedSeats).toHaveLength(
      2,
    );
  });

  it('duplicate delivery has idempotent effects and no duplicate receipt fetch', async () => {
    const envelope = holdEvent(held);
    await consumer.handle(envelope);
    const save = vi.spyOn(memory.repository, 'save');
    await consumer.handle(envelope);
    expect(save).not.toHaveBeenCalled();
    expect(reconcileHold).toHaveBeenCalledOnce();
  });

  it.each([
    [HOLD_EXPIRED_EVENT_TYPE, 'EXPIRED', 'expired'],
    [HOLD_RELEASED_EVENT_TYPE, 'RELEASED', 'released'],
    [HOLD_RELEASED_EVENT_TYPE, 'RELEASED', 'replaced'],
  ] as const)(
    'terminates the draft on %s/%s even before the hold response',
    async (type, state, reason) => {
      await consumer.handle(
        holdEvent({ ...held, version: 2, state }, type, reason),
      );
      await consumer.handle(holdEvent(held));
      await memory.store.applySnapshot(held);
      expect(memory.rows.get(dto.bookingKey)).toMatchObject({
        status: 'CANCELLED',
        holdState: state,
        holdVersion: 2,
        holdSnapshot: null,
      });
      expect(reconcileHold).not.toHaveBeenCalled();
    },
  );

  it('applies extension expiry once and ignores older held snapshots/events', async () => {
    await memory.store.applySnapshot(held);
    const extended = {
      ...held,
      version: 2,
      extensionUsed: true,
      expiresAt: '2026-11-15T17:12:00.000Z',
    };
    reconcileHold.mockImplementation(async () => {
      await memory.store.applySnapshot(extended);
    });
    await consumer.handle(
      holdEvent(extended, HOLD_EXTENDED_EVENT_TYPE, 'extended'),
    );
    await consumer.handle(holdEvent(held));
    await memory.store.applySnapshot(held);
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      holdVersion: 2,
      extensionUsed: true,
      expiresAt: new Date(extended.expiresAt),
    });
    expect(memory.rows.get(dto.bookingKey)!.legs[0].expiresAt).toBe(
      extended.expiresAt,
    );
  });

  it('does not resurrect a terminal draft even from an impossible higher-version held event', async () => {
    await consumer.handle(
      holdEvent(
        { ...held, version: 2, state: 'EXPIRED' },
        HOLD_EXPIRED_EVENT_TYPE,
        'expired',
      ),
    );
    await consumer.handle(holdEvent({ ...held, version: 3 }));
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      status: 'CANCELLED',
      holdVersion: 2,
    });
  });

  it('retains the committed version fence when async reconciliation fails, then retries the same event', async () => {
    const envelope = holdEvent(held);
    reconcileHold.mockRejectedValueOnce(new Error('dependency unavailable'));
    await expect(consumer.handle(envelope)).rejects.toThrow(
      'dependency unavailable',
    );
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      holdVersion: 1,
      reconciliationPending: true,
    });
    await consumer.handle(envelope);
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      holdVersion: 1,
      reconciliationPending: false,
    });
  });

  it('does not manufacture an intent from an unknown or foreign-owner event', async () => {
    const envelope = holdEvent(held);
    envelope.payload.ownerId = draftInput().bookingKey;
    expect(await consumer.handle(envelope)).toMatchObject({
      status: 'skipped',
    });
    expect(memory.rows.get(dto.bookingKey)!.holdVersion).toBe(0);
  });
});

describe('production hold lifecycle payload parser', () => {
  const snapshot = inventorySnapshot(createRequest(draftInput()));

  it('accepts additive envelope, payload and leg fields without persisting them', () => {
    const envelope = holdEvent(snapshot);
    Object.assign(envelope.payload, { future: { harmless: true } });
    Object.assign(envelope.payload.legs[0], { future: 42 });
    const parsed = parseHoldLifecycleEvent(envelope);
    expect(parsed).not.toHaveProperty('future');
    expect(parsed.legs[0]).not.toHaveProperty('future');
  });

  it.each([
    'holdId',
    'bookingKey',
    'ownerId',
    'aggregateVersion',
    'state',
    'allocationOutcome',
    'legs',
    'expiresAt',
    'extensionUsed',
    'reason',
  ])('rejects a missing required %s before database work', (key) => {
    const envelope = holdEvent(snapshot);
    delete (envelope.payload as unknown as Record<string, unknown>)[key];
    expect(() => parseHoldLifecycleEvent(envelope)).toThrow(
      PermanentEventError,
    );
  });

  it.each([
    { aggregateVersion: '1' },
    { aggregateVersion: 0 },
    { aggregateVersion: 1.5 },
    { expiresAt: '2026-02-31T12:00:00Z' },
    { expiresAt: null },
    { holdId: [snapshot.holdId] },
    { state: 'EXPIRED' },
    { reason: 'released' },
    { extensionUsed: 'false' },
    { legs: [] },
    { legs: [snapshot.legs[0], snapshot.legs[0]] },
    { nationalId: '29001010112345' },
    { passengerToken: 'secret' },
    { nested: { maskedNationalId: '**********1000' } },
  ])(
    'rejects malformed or identity-bearing production payload: %j',
    (extra) => {
      const envelope = holdEvent(snapshot);
      Object.assign(envelope.payload, extra);
      expect(() => parseHoldLifecycleEvent(envelope)).toThrow(
        PermanentEventError,
      );
    },
  );

  it.each([0, 2])('rejects unsupported envelope version %s', (version) => {
    expect(() =>
      parseHoldLifecycleEvent({ ...holdEvent(snapshot), version }),
    ).toThrow(PermanentEventError);
  });

  it('rejects mismatched producer, type and event state/reason', () => {
    expect(() =>
      parseHoldLifecycleEvent({ ...holdEvent(snapshot), producer: 'identity' }),
    ).toThrow(PermanentEventError);
    expect(() =>
      parseHoldLifecycleEvent({ ...holdEvent(snapshot), type: 'unknown' }),
    ).toThrow(PermanentEventError);
    const payload: HoldLifecyclePayloadV1 = {
      ...holdEvent(snapshot).payload,
      state: 'CANCELLED',
      expiresAt: null,
    };
    expect(() =>
      parseHoldLifecycleEvent({
        ...holdEvent(snapshot),
        payload,
        type: HOLD_HELD_EVENT_TYPE,
      }),
    ).toThrow(PermanentEventError);
  });
});
