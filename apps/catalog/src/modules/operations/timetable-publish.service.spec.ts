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

/**
 * Publishing a timetable version -- the happy paths.
 *
 * Every date here is fixed by a frozen clock, because the booking window the
 * diff covers starts at Cairo's today and the counts below are exact. The
 * window is 2026-06-20 to 2026-07-20 inclusive, and a publish effective on
 * 2026-06-22 therefore touches the 29 dates from 06-22 onwards.
 */
const DATES_FROM_EFFECTIVE = 29;
/** `EFFECTIVE_FROM` + 3, a date well inside the new version's range. */
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
    // Exact, not merely positive: every date the version runs on from its
    // effective date to the end of the window, and no date before it.
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

    // One transaction, and the apply pass that follows it opens none of its
    // own for a publish that only creates trips.
    expect(harness.transactions()).toBe(1);

    // All four writes landed, and they landed together.
    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(1);
    expect(harness.publishedEventTypes()).toContain(
      EVENT_TYPES.timetablePublished,
    );
    expect(harness.store.requests).toHaveLength(1);
    expect(JSON.parse(harness.store.requests[0].responseJson)).toEqual(result);

    // The audit entry says who, what and against which train, with `before`
    // null because nothing was superseded.
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
    // The day before the successor takes effect, so no civil day is left
    // without a live version.
    expect(previous.effectiveUntil).toBe('2026-06-21');
    expect(harness.store.timetables).toHaveLength(2);
    // And the predecessor is what the audit trail's `before` recorded.
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
    // Re-pointed, not recreated: the stops were rewritten in place and the
    // new station is there.
    expect(await harness.stopStationIdsOn(D_PLUS_3)).toHaveLength(4);
    // A re-point announces the trip again rather than withdrawing it --
    // withdrawing would destroy inventory's seats for a train still running.
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
    // 2026-06-26 is the first Friday on or after the effective date.
    expect((await harness.tripOn('2026-06-26')).status).toBe('withdrawn');
  });

  // Review Focus 4. The timer in TripsService can insert version-2 trips
  // before the apply pass runs, so the counts must come from the diff.
  it('reports the counts it computed even when the generation loop got there first', async () => {
    harness = makeHarness();
    // Exactly the race: the version commits, the timer sees it and generates,
    // and only then does the publish's own apply pass run.
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
    // And the apply pass did not double-insert what the timer already made.
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
    // The replay is answered from the stored response, without reopening a
    // transaction or asking inventory again.
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

    // Refused, not applied: still one version and one audit entry.
    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(1);
  });

  // CARRY 5: `record` inserts rather than saves, so a concurrent publish that
  // committed the same key first fails this transaction with a plain unique
  // violation. Re-reading the key is what tells that race apart from any
  // other insert failure.
  it('replays a response a concurrent publish of the same request committed', async () => {
    harness = makeHarness();
    const winner = await harness.service.publish(
      validRequest(),
      'key-race',
      OPERATOR,
    );

    // The loser's replay check runs before the winner commits, so it sees no
    // stored key and proceeds -- exactly the race.
    harness.hideNextFind('key-race');

    const replayed = await harness.service.publish(
      validRequest(),
      'key-race',
      OPERATOR,
    );

    expect(replayed).toEqual(winner);
    // The loser's transaction wrote nothing: one version, one audit entry.
    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(1);
  });
});
