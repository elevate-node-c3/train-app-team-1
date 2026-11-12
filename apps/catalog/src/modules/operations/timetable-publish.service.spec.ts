import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode, EVENT_TYPES } from '@app/contracts';

import {
  EFFECTIVE_FROM,
  makeHarness,
  OPERATOR,
  otherRequest,
  republishWithExtraStop,
  republishWithoutFridays,
  TODAY,
  validRequest,
  WINDOW_END,
  type PublishHarness,
} from '../../../../../test/fixtures/timetable-publish-harness.js';

// Frozen clock: the window is 2026-06-20..2026-07-20, so a publish effective
// 2026-06-22 touches 29 dates.
const DATES_FROM_EFFECTIVE = 29;
/** A date well inside the new version's range. */
const D_PLUS_3 = '2026-06-25';
/** Fridays from 2026-06-22 to 2026-07-20. */
const FRIDAYS_IN_WINDOW = 4;

describe('TimetablePublishService.publish', () => {
  let harness: PublishHarness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T06:00:00.000Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes version 1 and reports the trips it created', async () => {
    harness = makeHarness();

    const result = await harness.service.publish(
      validRequest(),
      'key-1',
      OPERATOR,
    );

    expect(result).toMatchObject({ version: 1, withdrawn: 0, changed: 0 });
    expect(result.created).toBeGreaterThan(0);
    // Exact: every date from the effective date to the window's end, none before.
    expect(result.created).toBe(DATES_FROM_EFFECTIVE);
    expect(result.timetableId).toBeTruthy();
    expect(harness.store.timetables[0]).toMatchObject({
      version: 1,
      effectiveFrom: EFFECTIVE_FROM,
      effectiveUntil: null,
      status: 'published',
    });
  });

  it('writes the version, its audit entry and its events in one transaction', async () => {
    harness = makeHarness();

    const result = await harness.service.publish(
      validRequest(),
      'key-tx',
      OPERATOR,
    );

    // One transaction; the apply pass opens none for a create-only publish.
    expect(harness.transactions()).toBe(1);

    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(1);
    expect(harness.publishedEventTypes()).toContain(
      EVENT_TYPES.timetablePublished,
    );
    expect(harness.store.requests).toHaveLength(1);
    expect(JSON.parse(harness.store.requests[0].responseJson)).toEqual(result);

    expect(harness.store.audit[0]).toMatchObject({
      action: 'timetable.published',
      actorAccountId: OPERATOR,
      ticketsAffected: 0,
      before: null,
    });
    expect(harness.store.audit[0].after).toMatchObject({
      version: 1,
      effectiveFrom: EFFECTIVE_FROM,
    });
  });

  it('bounds the previous version when republishing', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const previous = harness.store.timetables[0];
    expect(previous.effectiveUntil).toBeNull();

    const result = await harness.service.publish(
      validRequest(),
      'key-bound',
      OPERATOR,
    );

    expect(result.version).toBe(2);
    // Day before the successor, so no civil day is left without a version.
    expect(previous.effectiveUntil).toBe('2026-06-21');
    expect(harness.store.timetables).toHaveLength(2);
    expect(harness.store.audit[0].before).toMatchObject({
      timetableId: previous.id,
      version: 1,
      effectiveUntil: null,
    });
  });

  it('re-points a trip with no sales to the new version, keeping its trip id', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const before = await harness.tripOn(D_PLUS_3);
    expect(before.timetableVersion).toBe(1);

    await harness.service.publish(republishWithExtraStop(), 'key-2', OPERATOR);

    const after = await harness.tripOn(D_PLUS_3);
    expect(after.id).toBe(before.id);
    expect(after.timetableVersion).toBe(2);
    expect(await harness.stopStationIdsOn(D_PLUS_3)).toHaveLength(4);
    // Announce, don't withdraw: withdrawal would destroy seats for a running train.
    expect(harness.publishedEventTypes()).not.toContain(
      EVENT_TYPES.tripWithdrawn,
    );
    expect(
      harness
        .publishedEventTypes()
        .filter((type) => type === EVENT_TYPES.tripPublished),
    ).toHaveLength(DATES_FROM_EFFECTIVE);
  });

  it('leaves a trip before the new effective date on its old version', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const untouched = await harness.tripOn(TODAY);

    await harness.service.publish(republishWithExtraStop(), 'key-past', OPERATOR);

    // The publish may change the future and must never rewrite the past.
    expect(untouched.timetableVersion).toBe(1);
    expect(await harness.stopStationIdsOn(TODAY)).toHaveLength(3);
  });

  it('counts a re-pointed trip as changed, not as withdrawn and created', async () => {
    harness = makeHarness({ withExistingVersion: true });

    const result = await harness.service.publish(
      republishWithExtraStop(),
      'key-3',
      OPERATOR,
    );

    expect(result).toMatchObject({ created: 0, withdrawn: 0 });
    expect(result.changed).toBeGreaterThan(0);
    expect(result.changed).toBe(DATES_FROM_EFFECTIVE);
  });

  it('withdraws a trip the new version no longer runs and announces it', async () => {
    harness = makeHarness({ withExistingVersion: true });

    const result = await harness.service.publish(
      republishWithoutFridays(),
      'key-4',
      OPERATOR,
    );

    expect(result.withdrawn).toBeGreaterThan(0);
    expect(result.withdrawn).toBe(FRIDAYS_IN_WINDOW);
    expect(result.changed).toBe(DATES_FROM_EFFECTIVE - FRIDAYS_IN_WINDOW);
    expect(harness.publishedEventTypes()).toContain(EVENT_TYPES.tripWithdrawn);
    // First Friday on or after the effective date.
    expect((await harness.tripOn('2026-06-26')).status).toBe('withdrawn');
  });

  // A withdrawn trip still owns its (train, service_date). A diff that misses
  // it would count the date as created and leave it withdrawn, with no
  // `TripPublished` for inventory to recreate seats.
  describe('a date whose trip was withdrawn', () => {
    it('resurrects it, keeping its trip id, and announces it again', async () => {
      harness = makeHarness({ withExistingVersion: true });

      const dropped = await harness.service.publish(
        republishWithoutFridays(),
        'drop-fridays',
        OPERATOR,
      );
      expect(dropped.withdrawn).toBe(FRIDAYS_IN_WINDOW);

      const withdrawnBefore = harness.store.trips.filter(
        (trip) => trip.status === 'withdrawn',
      );
      expect(withdrawnBefore).toHaveLength(FRIDAYS_IN_WINDOW);
      const idsBefore = withdrawnBefore.map((trip) => trip.id).sort();
      const datesBefore = withdrawnBefore.map((trip) => trip.serviceDate);

      const publishedEventsBefore = harness
        .publishedEventTypes()
        .filter((type) => type === EVENT_TYPES.tripPublished).length;

      const restored = await harness.service.publish(
        validRequest({ effectiveFrom: '2026-06-23' }),
        'restore-fridays',
        OPERATOR,
      );

      // Rows already existed, so `changed`, not `created`; `created` promises
      // a new trip id.
      expect(restored.created).toBe(0);
      expect(restored.withdrawn).toBe(0);
      expect(restored.changed).toBeGreaterThan(0);

      for (const serviceDate of datesBefore) {
        const trip = await harness.tripOn(serviceDate);
        expect(trip.status).toBe('published');
        expect(trip.timetableVersion).toBe(3);
      }
      const idsAfter = harness.store.trips
        .filter((trip) => datesBefore.includes(trip.serviceDate))
        .map((trip) => trip.id)
        .sort();
      expect(idsAfter).toEqual(idsBefore);

      // Inventory must be told, or destroyed seats are never recreated.
      const publishedEventsAfter = harness
        .publishedEventTypes()
        .filter((type) => type === EVENT_TYPES.tripPublished).length;
      expect(publishedEventsAfter - publishedEventsBefore).toBe(
        restored.changed,
      );
      expect(
        harness.store.trips.filter((trip) =>
          datesBefore.includes(trip.serviceDate),
        ),
      ).toHaveLength(FRIDAYS_IN_WINDOW);
    });

    it('does not count a withdrawn trip the new version still does not run', async () => {
      harness = makeHarness({ withExistingVersion: true });

      await harness.service.publish(
        republishWithoutFridays(),
        'drop-1',
        OPERATOR,
      );

      // Still dropped: another withdrawal would describe work that did not happen.
      const again = await harness.service.publish(
        republishWithoutFridays({ effectiveFrom: '2026-06-23' }),
        'drop-2',
        OPERATOR,
      );

      expect(again.withdrawn).toBe(0);
      expect(again.created).toBe(0);
      expect(
        harness
          .publishedEventTypes()
          .filter((type) => type === EVENT_TYPES.tripWithdrawn),
      ).toHaveLength(FRIDAYS_IN_WINDOW);
    });
  });

  // The timer can insert version-2 trips before the apply pass, so counts
  // must come from the diff.
  it('reports the counts it computed even when the generation loop got there first', async () => {
    harness = makeHarness();
    harness.afterFirstCommit(() =>
      harness.simulateGeneration(EFFECTIVE_FROM, WINDOW_END),
    );

    const result = await harness.service.publish(
      validRequest(),
      'key-5',
      OPERATOR,
    );

    expect(result.created).toBeGreaterThan(0);
    expect(result.created).toBe(DATES_FROM_EFFECTIVE);
    expect(harness.store.trips).toHaveLength(DATES_FROM_EFFECTIVE);
  });

  it('replays the first response for a repeated idempotency key', async () => {
    harness = makeHarness();

    const first = await harness.service.publish(
      validRequest(),
      'key-6',
      OPERATOR,
    );
    const firstOutboxCount = await harness.outboxCount();

    const second = await harness.service.publish(
      validRequest(),
      'key-6',
      OPERATOR,
    );

    expect(second).toEqual(first);
    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.outboxCount()).toBe(firstOutboxCount);
    expect(await harness.auditCount()).toBe(1);
    // Replay from the stored response: no new transaction, no second inventory ask.
    expect(harness.transactions()).toBe(1);
    expect(harness.seatUsageAsks()).toHaveLength(1);
  });

  it('refuses a key reused with a different payload', async () => {
    harness = makeHarness();

    await harness.service.publish(validRequest(), 'key-7', OPERATOR);

    await expect(
      harness.service.publish(otherRequest(), 'key-7', OPERATOR),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [expect.objectContaining({ field: 'Idempotency-Key' })],
    });

    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(1);
  });

  // `record` inserts, so a concurrent same-key publish fails with a plain
  // unique violation; re-reading the key tells that race apart.
  it('replays a response a concurrent publish of the same request committed', async () => {
    harness = makeHarness();
    const winner = await harness.service.publish(
      validRequest(),
      'key-race',
      OPERATOR,
    );

    // The loser checks before the winner commits and sees no key.
    harness.hideNextFind('key-race');

    const replayed = await harness.service.publish(
      validRequest(),
      'key-race',
      OPERATOR,
    );

    expect(replayed).toEqual(winner);
    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(1);
  });
});
