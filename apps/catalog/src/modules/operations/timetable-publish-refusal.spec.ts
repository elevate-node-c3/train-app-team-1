import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@app/contracts';

import {
  BENI_SUEF,
  CAIRO,
  FIRST_CLASS,
  GIZA,
  LAYOUT,
  makeHarness,
  OPERATOR,
  SECOND_CLASS,
  twoCoachesReversed,
  republishTenMinutesLater,
  republishWithExtraStop,
  republishWithoutFridays,
  requestWithThreeProblems,
  TODAY,
  validRequest,
  type PublishHarness,
} from '../../../../../test/fixtures/timetable-publish-harness.js';
import { SeatUsageUnavailableError } from './inventory-seat-usage.grpc.client.js';

// Refusals: tell the operator what to change and write nothing, because each
// promise may already be sold.
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

    // All three faults in one answer; stopping at the first costs more round trips.
    expect(details.length).toBeGreaterThanOrEqual(3);
    expect(details.map((detail) => detail.field)).toEqual(
      expect.arrayContaining([
        'stops[0].arrivalTime',
        'stops[1].stationId',
        'stops[2].stationId',
      ]),
    );
    // Every detail names the change to make.
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

  // Silence is never zero: consult the seam even with no affected trip.
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
    expect(detail.issue).toContain(sold.id);
    expect(detail.issue).toContain(D_PLUS_3);
    expect(detail.issue).toContain('2 sold');
    // A later effective date is the one thing that works.
    expect(detail.action).toMatch(/effectiveFrom of \d{4}-\d{2}-\d{2} or later/);

    expect(await harness.timetableCount()).toBe(1);
    expect(await harness.auditCount()).toBe(0);
    expect(harness.store.timetables[0].effectiveUntil).toBeNull();
    expect((await harness.tripOn(D_PLUS_3)).timetableVersion).toBe(1);
  });

  it('refuses a time change to a held trip (that is the Sprint 5 delay)', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const held = await harness.tripOn(D_PLUS_3);
    // Held, not sold; only times move. A holder must be told, not quietly moved.
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

    // The middle stop is where the hold boards; the remaining pair has fares.
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
    // Names the station, not just "shape changed".
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

    // No remap: the sold ticket still names stations in the old route, so the
    // publish gives way.
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

    // Same route and times, so nothing a ticket depends on moves; refusing
    // would block republishing after a sale.
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

    // Inclusive boundary: today's trips have not run yet.
    const result = await harness.service.publish(
      validRequest({ effectiveFrom: TODAY }),
      'k',
      OPERATOR,
    );

    expect(result.version).toBe(1);
  });

  // The generator validates fares against the train's real coaches and
  // swallows the error, so a subset composition would commit but generate none.
  describe('the submitted composition', () => {
    it('refuses a composition that is not the train\'s, before writing anything', async () => {
      harness = makeHarness();

      const rejection = await harness.service
        .publish(
          validRequest({
            coaches: [
              {
                position: 1,
                coachNumber: 1,
                travelClassId: SECOND_CLASS,
                coachLayoutId: LAYOUT,
              },
            ],
          }),
          'k',
          OPERATOR,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'coaches' }),
        ]),
      });

      const detail = (
        rejection as { details: { field: string; issue: string; action: string }[] }
      ).details.find((candidate) => candidate.field === 'coaches')!;
      expect(detail.issue).toContain(FIRST_CLASS);
      expect(detail.action).toMatch(/cannot be changed through this endpoint/);

      await expectNothingWritten();
      expect(harness.seatUsageAsks()).toEqual([]);
    });

    it('refuses a coach whose number or position was altered', async () => {
      harness = makeHarness();

      await expect(
        harness.service.publish(
          validRequest({
            coaches: [
              {
                position: 1,
                coachNumber: 7,
                travelClassId: FIRST_CLASS,
                coachLayoutId: LAYOUT,
              },
            ],
          }),
          'k',
          OPERATOR,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'coaches' }),
        ]),
      });

      await expectNothingWritten();
    });

    // The symmetric case: the rule must not refuse a correct request.
    it('publishes when the submitted composition matches the train', async () => {
      harness = makeHarness();

      const result = await harness.service.publish(
        validRequest(),
        'k',
        OPERATOR,
      );

      expect(result.version).toBe(1);
      expect(result.created).toBeGreaterThan(0);
      expect(await harness.timetableCount()).toBe(1);
      expect(await harness.auditCount()).toBe(1);
      // Trips really generated; that is what the mismatch refusal protects.
      expect(harness.store.trips).toHaveLength(result.created);
    });

    // Order is the client's business, not a difference.
    it('accepts the train\'s coaches in any array order', async () => {
      harness = makeHarness({ withTwoCoaches: true });
      const request = validRequest({ coaches: twoCoachesReversed() });

      const result = await harness.service.publish(request, 'k', OPERATOR);

      expect(result.version).toBe(1);
    });
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
    // Refused before the seam: nothing to ask about.
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

  // `supersede` leaves a same-day or future predecessor to the exclusion
  // constraint (23P01); unmapped, that legitimate conflict becomes a 500.
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
