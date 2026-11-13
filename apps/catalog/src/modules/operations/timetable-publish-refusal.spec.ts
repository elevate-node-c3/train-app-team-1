import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addCivilDays,
  ErrorCode,
  type ValidationIssueRef,
} from '@app/contracts';

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
  WINDOW_END,
  validRequest,
  type PublishHarness,
} from '../../../../../test/fixtures/timetable-publish-harness.js';
import { SeatUsageUnavailableError } from './inventory-seat-usage.grpc.client.js';

// Refusals must explain the fix and write nothing; existing trips may already be sold.
const D_PLUS_3 = '2026-06-25';
/** The first Friday on or after the effective date. */
const FIRST_FRIDAY = '2026-06-26';
const LATER_DATE = addCivilDays(WINDOW_END, 1);

describe('TimetablePublishService refusals', () => {
  let harness: PublishHarness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T06:00:00.000Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    const details = (rejection as { details: ValidationIssueRef[] }).details;

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
        issueKey: expect.stringMatching(/^ISSUE_/),
        actionKey: expect.stringMatching(/^ACTION_/),
      });
      expect(detail).not.toHaveProperty('issue');
      expect(detail).not.toHaveProperty('action');
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
    ).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      details: [
        {
          field: 'trainNumber',
          issueKey: 'ISSUE_SEAT_USAGE_UNAVAILABLE',
          actionKey: 'ACTION_RETRY_PUBLISH',
          params: { retryAfterSeconds: '5' },
        },
      ],
    });

    await expectNothingWritten();
  });

  it('preserves the trip and date when a seat-usage answer is missing', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const trip = await harness.tripOn(validRequest().effectiveFrom);
    const dependency = harness.service as unknown as {
      seatUsage: { seatUsageForTrips: () => Promise<Map<string, unknown>> };
    };
    vi.spyOn(dependency.seatUsage, 'seatUsageForTrips').mockResolvedValue(
      new Map(),
    );

    await expect(
      harness.service.publish(validRequest(), 'missing-usage', OPERATOR),
    ).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      details: [
        {
          issueKey: 'ISSUE_TRIP_SEAT_USAGE_UNAVAILABLE',
          actionKey: 'ACTION_RETRY_PUBLISH',
          params: {
            tripId: trip.id,
            serviceDate: trip.serviceDate,
            retryAfterSeconds: '5',
          },
        },
      ],
    });
    expect(await harness.auditCount()).toBe(0);
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

    const [detail] = (rejection as { details: ValidationIssueRef[] }).details;
    expect(detail).toMatchObject({
      issueKey: 'ISSUE_PUBLISH_WOULD_CHANGE_IN_USE_TRIP',
      actionKey: 'ACTION_PUBLISH_AFTER_IN_USE_TRIPS',
      params: {
        tripId: sold.id,
        serviceDate: D_PLUS_3,
        soldCount: '2',
        heldCount: '0',
        laterDate: LATER_DATE,
      },
    });

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
      (rejection as { details: ValidationIssueRef[] }).details[0],
    ).toMatchObject({
      issueKey: 'ISSUE_PUBLISH_WOULD_CHANGE_IN_USE_TRIP',
      actionKey: 'ACTION_PUBLISH_AFTER_IN_USE_TRIPS',
      params: {
        tripId: held.id,
        serviceDate: D_PLUS_3,
        soldCount: '0',
        heldCount: '1',
        laterDate: LATER_DATE,
      },
    });

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
    const [detail] = (rejection as { details: ValidationIssueRef[] }).details;
    expect(detail.field).toBe('stops');
    // Names the station, not just "shape changed".
    expect(detail.rejectedValue).toEqual([GIZA]);
    expect(detail).toMatchObject({
      issueKey: 'ISSUE_PUBLISH_WOULD_DROP_IN_USE_STOPS',
      actionKey: 'ACTION_KEEP_IN_USE_STOPS_OR_PUBLISH_LATER',
      params: {
        tripId: held.id,
        serviceDate: D_PLUS_3,
        soldCount: '0',
        heldCount: '1',
        stationIds: GIZA,
        laterDate: LATER_DATE,
      },
    });

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

    // Refuse route changes that would remap stations named on sold tickets.
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
      (rejection as { details: ValidationIssueRef[] }).details[0],
    ).toMatchObject({
      issueKey: 'ISSUE_PUBLISH_WOULD_WITHDRAW_IN_USE_TRIP',
      actionKey: 'ACTION_KEEP_IN_USE_WEEKDAY_OR_PUBLISH_LATER',
      params: {
        tripId: sold.id,
        serviceDate: FIRST_FRIDAY,
        soldCount: '3',
        heldCount: '0',
        laterDate: LATER_DATE,
      },
    });

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
    const result = await harness.service.publish(validRequest(), 'k', OPERATOR);

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
          issueKey: 'ISSUE_EFFECTIVE_DATE_IN_THE_PAST',
          actionKey: 'ACTION_PICK_EFFECTIVE_DATE_NOW_OR_LATER',
          params: { today: TODAY },
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
    it('uses a parameterless ref when the train has no current coaches', async () => {
      harness = makeHarness();
      const dependency = harness.service as unknown as {
        trips: { getTrainCoaches: () => Promise<unknown[]> };
      };
      vi.spyOn(dependency.trips, 'getTrainCoaches').mockResolvedValue([]);

      await expect(
        harness.service.publish(validRequest(), 'empty-coaches', OPERATOR),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: [
          {
            field: 'coaches',
            issueKey: 'ISSUE_TRAIN_HAS_NO_COACHES',
            actionKey: 'ACTION_ADD_TRAIN_COACHES_BEFORE_PUBLISH',
          },
        ],
      });
      await expectNothingWritten();
    });

    it("refuses a composition that is not the train's, before writing anything", async () => {
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
        rejection as { details: ValidationIssueRef[] }
      ).details.find((candidate) => candidate.field === 'coaches')!;
      expect(detail).toMatchObject({
        issueKey: 'ISSUE_COACH_COMPOSITION_MISMATCH',
        actionKey: 'ACTION_SEND_CURRENT_COACH_COMPOSITION',
        params: {
          position: '1',
          coachNumber: '1',
          travelClassId: FIRST_CLASS,
          coachLayoutId: LAYOUT,
        },
      });
      expect(JSON.stringify(detail)).not.toMatch(/generation|sprint|endpoint/);

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
      expect(harness.store.trips).toHaveLength(result.created);
    });

    // Order is the client's business, not a difference.
    it("accepts the train's coaches in any array order", async () => {
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

  // Map same-day/future predecessor exclusion conflicts (23P01) to refusal, not 500.
  it('turns the exclusion constraint into a conflict naming the clashing version', async () => {
    harness = makeHarness({ withExistingVersion: true });
    harness.store.timetables[0].effectiveFrom = '2026-06-22';
    harness.failNextInsertWith(
      Object.assign(
        new Error('conflicting key value violates exclusion constraint'),
        {
          code: '23P01',
        },
      ),
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
      (rejection as { details: ValidationIssueRef[] }).details[0],
    ).toMatchObject({
      issueKey: 'ISSUE_TIMETABLE_OVERLAPS_OPEN_ENDED_VERSION',
      actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
      params: { version: '1', effectiveFrom: '2026-06-22' },
    });

    expect(await harness.auditCount()).toBe(0);
    expect(harness.store.requests).toHaveLength(0);
  });

  it('carries both dates for a bounded clashing version without English fragments', async () => {
    harness = makeHarness({ withExistingVersion: true });
    harness.store.timetables[0].effectiveUntil = D_PLUS_3;
    harness.failNextInsertWith(
      Object.assign(new Error('overlap'), { code: '23P01' }),
    );

    await expect(
      harness.service.publish(validRequest(), 'bounded', OPERATOR),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [
        {
          field: 'effectiveFrom',
          issueKey: 'ISSUE_TIMETABLE_OVERLAPS_PUBLISHED_VERSION',
          actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
          params: {
            version: '1',
            effectiveFrom: '2026-06-10',
            effectiveUntil: D_PLUS_3,
          },
        },
      ],
    });
    expect(await harness.auditCount()).toBe(0);
  });

  it('returns separate structured refs for every clashing version', async () => {
    harness = makeHarness({ withExistingVersion: true });
    const bounded = harness.store.timetables[0];
    bounded.effectiveUntil = D_PLUS_3;
    harness.store.timetables.push({
      ...bounded,
      id: 'future-version',
      version: 2,
      effectiveFrom: FIRST_FRIDAY,
      effectiveUntil: null,
    });
    harness.failNextInsertWith(
      Object.assign(new Error('overlap'), { code: '23P01' }),
    );

    const rejection = await harness.service
      .publish(validRequest(), 'multiple-overlaps', OPERATOR)
      .catch((error: unknown) => error);
    expect((rejection as { details: ValidationIssueRef[] }).details).toEqual([
      {
        field: 'effectiveFrom',
        rejectedValue: validRequest().effectiveFrom,
        issueKey: 'ISSUE_TIMETABLE_OVERLAPS_PUBLISHED_VERSION',
        actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
        params: {
          version: '1',
          effectiveFrom: '2026-06-10',
          effectiveUntil: D_PLUS_3,
        },
      },
      {
        field: 'effectiveFrom',
        rejectedValue: validRequest().effectiveFrom,
        issueKey: 'ISSUE_TIMETABLE_OVERLAPS_OPEN_ENDED_VERSION',
        actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
        params: { version: '2', effectiveFrom: FIRST_FRIDAY },
      },
    ]);
    expect(await harness.auditCount()).toBe(0);
  });

  it('uses a parameterless overlap fallback when the clashing row cannot be read', async () => {
    harness = makeHarness();
    harness.failNextInsertWith(
      Object.assign(new Error('overlap'), { code: '23P01' }),
    );

    await expect(
      harness.service.publish(validRequest(), 'missing-overlap', OPERATOR),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [
        {
          field: 'effectiveFrom',
          issueKey: 'ISSUE_TIMETABLE_OVERLAPS_PUBLISHED_RANGE',
          actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
        },
      ],
    });
    await expectNothingWritten();
  });

  it('carries one complete language-free ref for every expected coach', async () => {
    harness = makeHarness({ withTwoCoaches: true });

    const rejection = await harness.service
      .publish(validRequest(), 'coaches', OPERATOR)
      .catch((error: unknown) => error);
    const details = (
      rejection as { details: ValidationIssueRef[] }
    ).details.filter(
      (detail) => detail.issueKey === 'ISSUE_COACH_COMPOSITION_MISMATCH',
    );
    expect(details).toHaveLength(2);
    expect(details.map((detail) => detail.params)).toEqual([
      {
        position: '1',
        coachNumber: '1',
        travelClassId: FIRST_CLASS,
        coachLayoutId: LAYOUT,
      },
      {
        position: '2',
        coachNumber: '2',
        travelClassId: SECOND_CLASS,
        coachLayoutId: LAYOUT,
      },
    ]);
    await expectNothingWritten();
  });

  // Any other insert failure must not be mistaken for the idempotency race.
  it('rethrows an insert failure that is not a reused key', async () => {
    harness = makeHarness();
    harness.failNextInsertWith(
      Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          code: '23505',
        },
      ),
    );

    await expect(
      harness.service.publish(validRequest(), 'k', OPERATOR),
    ).rejects.toThrow(/duplicate key value/);

    await expectNothingWritten();
  });
});
