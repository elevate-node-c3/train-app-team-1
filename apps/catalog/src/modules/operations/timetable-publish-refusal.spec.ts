import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@app/contracts';

import {
  BENI_SUEF,
  CAIRO,
  GIZA,
  makeHarness,
  OPERATOR,
  republishTenMinutesLater,
  republishWithExtraStop,
  republishWithoutFridays,
  requestWithThreeProblems,
  TODAY,
  validRequest,
  type PublishHarness,
} from '../../../../../test/fixtures/timetable-publish-harness.js';
import { SeatUsageUnavailableError } from './inventory-seat-usage.grpc.client.js';

/**
 * Publishing a timetable version -- the refusals.
 *
 * Each one is a promise someone may already have bought, so every case below
 * asserts the same two things: the operator is told what to change, and
 * nothing at all was written.
 */
const D_PLUS_3 = '2026-06-25';
/** The first Friday on or after the effective date. */
const FIRST_FRIDAY = '2026-06-26';

describe('TimetablePublishService refusals', () => {
  let harness: PublishHarness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T06:00:00.000Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Nothing committed, in any of the four places a publish writes. */
  async function expectNothingWritten(): Promise<void> {
    expect(await harness.timetableCount()).toBe(0);
    expect(await harness.outboxCount()).toBe(0);
    expect(await harness.auditCount()).toBe(0);
    expect(harness.store.requests).toHaveLength(0);
  }

  it('writes nothing and names every problem when validation fails', async () => {
    harness = makeHarness();

    const rejection = await harness.service
      .publish(requestWithThreeProblems(), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    const details = (rejection as { details: { field: string }[] }).details;

    // All three faults in one answer: a first stop with an arrival time, a
    // repeated station, and a station the catalogue does not have. A publish
    // that stopped at the first would cost the operator two more round trips.
    expect(details.length).toBeGreaterThanOrEqual(3);
    expect(details.map((detail) => detail.field)).toEqual(
      expect.arrayContaining([
        'stops[0].arrivalTime',
        'stops[1].stationId',
        'stops[2].stationId',
      ]),
    );
    // Every detail names the change to make (BR-57).
    for (const detail of details) {
      expect(detail).toMatchObject({
        issue: expect.any(String),
        action: expect.any(String),
      });
    }

    await expectNothingWritten();
  });

  it('refuses when inventory cannot answer, and says it is retryable', async () => {
    harness = makeHarness();
    harness.rejectSeatUsage(
      new SeatUsageUnavailableError('Could not reach inventory for seat usage'),
    );

    await expect(
      harness.service.publish(validRequest(), 'k', OPERATOR),
    ).rejects.toMatchObject({ code: ErrorCode.DEPENDENCY_UNAVAILABLE });

    await expectNothingWritten();
  });

  // Silence is never zero. A publish must consult the seam even when it would
  // touch no existing trip, or an unanswered question becomes "no tickets".
  it('consults the seam on every publish, including one with no affected trip', async () => {
    harness = makeHarness();

    await harness.service.publish(validRequest(), 'k', OPERATOR);

    expect(harness.seatUsageAsks()).toEqual([[]]);
  });

  it('refuses a change to a trip with sold seats, listing the trips and counts', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const sold = await harness.tripOn(D_PLUS_3);
    harness.answerSeatUsage(sold.id, {
      soldCount: 2,
      heldCount: 0,
      stationIdsInUse: [CAIRO],
    });

    const rejection = await harness.service
      .publish(republishWithExtraStop(), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [expect.objectContaining({ field: 'stops' })],
    });

    const [detail] = (rejection as { details: { issue: string; action: string }[] })
      .details;
    // The trips and the counts, so the operator can go and look.
    expect(detail.issue).toContain(sold.id);
    expect(detail.issue).toContain(D_PLUS_3);
    expect(detail.issue).toContain('2 sold');
    // And a later effective date, which is the one thing that does work.
    expect(detail.action).toMatch(/effectiveFrom of \d{4}-\d{2}-\d{2} or later/);

    // The version that was already live is untouched, and no second one exists.
    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(0);
    expect(harness.store.timetables[0].effectiveUntil).toBeNull();
    expect((await harness.tripOn(D_PLUS_3)).timetableVersion).toBe(1);
  });

  it('refuses a time change to a held trip (that is the Sprint 5 delay)', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const held = await harness.tripOn(D_PLUS_3);
    // Held, not sold, and the stop set does not move at all -- only the
    // clock readings do. A traveller holding a seat on the old time has to
    // be told, not quietly moved.
    harness.answerSeatUsage(held.id, {
      soldCount: 0,
      heldCount: 1,
      stationIdsInUse: [CAIRO, BENI_SUEF],
    });

    const rejection = await harness.service
      .publish(republishTenMinutesLater(), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [expect.objectContaining({ field: 'stops' })],
    });
    expect(
      (rejection as { details: { issue: string }[] }).details[0].issue,
    ).toContain('1 held');

    expect(await harness.auditCount()).toBe(0);
    expect(harness.store.timetables).toHaveLength(1);
  });

  it('refuses removing a stop a hold boards at', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const held = await harness.tripOn(D_PLUS_3);
    harness.answerSeatUsage(held.id, {
      soldCount: 0,
      heldCount: 1,
      stationIdsInUse: [GIZA, BENI_SUEF],
    });

    // The three-station route minus its middle stop, which is where the hold
    // boards. Fares for the remaining pair already exist.
    const withoutGiza = validRequest();
    const rejection = await harness.service
      .publish(
        {
          ...withoutGiza,
          stops: [
            {
              stationId: CAIRO,
              position: 1,
              dayOffset: 0,
              arrivalTime: null,
              departureTime: '08:00',
            },
            {
              stationId: BENI_SUEF,
              position: 2,
              dayOffset: 0,
              arrivalTime: '10:00',
              departureTime: null,
            },
          ],
        },
        'k',
        OPERATOR,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({ code: ErrorCode.CONFLICT });
    const [detail] = (
      rejection as { details: { field: string; rejectedValue: unknown }[] }
    ).details;
    expect(detail.field).toBe('stops');
    // Named by station, not merely "the shape changed": the operator needs to
    // know which stop cannot go.
    expect(detail.rejectedValue).toEqual([GIZA]);

    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses adding a stop to a sold trip (no remap this sprint)', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const sold = await harness.tripOn(D_PLUS_3);
    harness.answerSeatUsage(sold.id, {
      soldCount: 1,
      heldCount: 0,
      stationIdsInUse: [CAIRO, BENI_SUEF],
    });

    await expect(
      harness.service.publish(republishWithExtraStop(), 'k', OPERATOR),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [expect.objectContaining({ field: 'stops' })],
    });

    // No remap: the sold ticket keeps naming stations in a route this publish
    // would have rewritten, so the publish is the thing that gives way.
    expect(await harness.stopStationIdsOn(D_PLUS_3)).toHaveLength(3);
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses withdrawing a day a sold trip runs on', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const sold = await harness.tripOn(FIRST_FRIDAY);
    harness.answerSeatUsage(sold.id, {
      soldCount: 3,
      heldCount: 0,
      stationIdsInUse: [CAIRO],
    });

    const rejection = await harness.service
      .publish(republishWithoutFridays(), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [expect.objectContaining({ field: 'runningDays' })],
    });
    expect(
      (rejection as { details: { issue: string }[] }).details[0].issue,
    ).toContain('3 sold');

    // Still running, and still version 1.
    expect((await harness.tripOn(FIRST_FRIDAY)).status).toBe('published');
    expect(await harness.auditCount()).toBe(0);
  });

  it('allows a republish that moves only the version pointer of a sold trip', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const sold = await harness.tripOn(D_PLUS_3);
    harness.answerSeatUsage(sold.id, {
      soldCount: 4,
      heldCount: 0,
      stationIdsInUse: [CAIRO, BENI_SUEF],
    });

    // The same route at the same times: nothing a ticket depends on moves,
    // so there is nothing to refuse. Refusing here would make a timetable
    // unpublishable for a month after its first sale.
    const result = await harness.service.publish(
      validRequest(),
      'k',
      OPERATOR,
    );

    expect(result.version).toBe(2);
    expect((await harness.tripOn(D_PLUS_3)).timetableVersion).toBe(2);
  });

  it('refuses an effectiveFrom in the past', async () => {
    harness = makeHarness();

    const rejection = await harness.service
      .publish(validRequest({ effectiveFrom: '2026-06-19' }), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: expect.arrayContaining([
        expect.objectContaining({
          field: 'effectiveFrom',
          rejectedValue: '2026-06-19',
        }),
      ]),
    });

    await expectNothingWritten();
  });

  it('accepts an effectiveFrom of today', async () => {
    harness = makeHarness();

    // The boundary is inclusive: today's trips have not run yet, and a
    // same-day publish is a normal operator action.
    const result = await harness.service.publish(
      validRequest({ effectiveFrom: TODAY }),
      'k',
      OPERATOR,
    );

    expect(result.version).toBe(1);
  });

  it('refuses an unknown train number', async () => {
    harness = makeHarness();

    const rejection = await harness.service
      .publish(validRequest({ trainNumber: '404' }), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: [
        expect.objectContaining({
          field: 'trainNumber',
          rejectedValue: '404',
        }),
      ],
    });

    await expectNothingWritten();
    // Refused before the seam was troubled: there is nothing to ask about.
    expect(harness.seatUsageAsks()).toEqual([]);
  });

  it('refuses running days that are not weekdays', async () => {
    harness = makeHarness();

    await expect(
      harness.service.publish(
        validRequest({ runningDays: [7] }),
        'k',
        OPERATOR,
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'runningDays', rejectedValue: 7 }),
      ]),
    });

    await expectNothingWritten();
  });

  // CARRY 2: `supersede` leaves a same-day or future-dated predecessor to the
  // exclusion constraint, which raises a raw 23P01. Nothing else in this
  // codebase matches that code, so without this the operator gets a 500 for a
  // legitimate conflict.
  it('turns the exclusion constraint into a conflict naming the clashing version', async () => {
    harness = makeHarness({ withExistingVersion: true });
    harness.store.timetables[0].effectiveFrom = '2026-06-22';
    harness.failNextInsertWith(
      Object.assign(new Error('conflicting key value violates exclusion constraint'), {
        code: '23P01',
      }),
    );

    const rejection = await harness.service
      .publish(validRequest(), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [expect.objectContaining({ field: 'effectiveFrom' })],
    });
    expect(
      (rejection as { details: { issue: string }[] }).details[0].issue,
    ).toContain('version(s) 1');

    expect(await harness.auditCount()).toBe(0);
    expect(harness.store.requests).toHaveLength(0);
  });

  // Any other insert failure must not be mistaken for the idempotency race.
  it('rethrows an insert failure that is not a reused key', async () => {
    harness = makeHarness();
    harness.failNextInsertWith(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
    );

    await expect(
      harness.service.publish(validRequest(), 'k', OPERATOR),
    ).rejects.toThrow(/duplicate key value/);

    await expectNothingWritten();
  });
});
