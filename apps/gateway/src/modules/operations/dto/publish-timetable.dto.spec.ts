import { createValidationPipe } from '@app/common';
import { describe, expect, it } from 'vitest';

import {
  PublishTimetableCoachDto,
  PublishTimetableDto,
  PublishTimetableStopDto,
} from './publish-timetable.dto.js';

const ORIGIN = '11111111-1111-4111-8111-111111111111';
const DESTINATION = '22222222-2222-4222-8222-222222222222';
const TRAVEL_CLASS = '33333333-3333-4333-8333-333333333333';
const COACH_LAYOUT = '44444444-4444-4444-8444-444444444444';

function validBody() {
  return {
    trainNumber: '903',
    runningDays: [0, 1],
    effectiveFrom: '2026-12-01',
    stops: [
      { stationId: ORIGIN, position: 0, dayOffset: 0, departureTime: '06:00' },
      {
        stationId: DESTINATION,
        position: 1,
        dayOffset: 0,
        arrivalTime: '07:00',
      },
    ],
    coaches: [
      {
        position: 0,
        coachNumber: 1,
        travelClassId: TRAVEL_CLASS,
        coachLayoutId: COACH_LAYOUT,
      },
    ],
    fares: [],
  };
}

describe('publish timetable details through the real validation pipe', () => {
  it('preserves the nested DTO transformations for a valid body', async () => {
    const dto = await createValidationPipe().transform(validBody(), {
      type: 'body',
      metatype: PublishTimetableDto,
    });

    expect(dto).toBeInstanceOf(PublishTimetableDto);
    expect(dto.stops[0]).toBeInstanceOf(PublishTimetableStopDto);
    expect(dto.coaches[0]).toBeInstanceOf(PublishTimetableCoachDto);
    expect(dto).toEqual(validBody());
  });

  it.each(['arrivalTime', 'departureTime'] as const)(
    'keeps the clock-time context for %s',
    async (field) => {
      const body = validBody();
      body.stops[0][field] = '24:00';

      await expect(
        createValidationPipe().transform(body, {
          type: 'body',
          metatype: PublishTimetableDto,
        }),
      ).rejects.toMatchObject({
        response: {
          message: expect.arrayContaining([
            expect.objectContaining({
              field: `stops.0.${field}`,
              rejectedValue: '24:00',
              issueKey: 'ISSUE_CLOCK_TIME_FORMAT',
            }),
          ]),
        },
      });
    },
  );

  it('keeps the civil-date context for effectiveFrom', async () => {
    await expect(
      createValidationPipe().transform(
        { ...validBody(), effectiveFrom: '01-12-2026' },
        {
          type: 'body',
          metatype: PublishTimetableDto,
        },
      ),
    ).rejects.toMatchObject({
      response: {
        message: [
          {
            field: 'effectiveFrom',
            rejectedValue: '01-12-2026',
            issueKey: 'ISSUE_CIVIL_DATE_FORMAT',
          },
        ],
      },
    });
  });

  it.each(['runningDays', 'stops', 'coaches'])(
    'keeps the minimum-list-size meaning for %s',
    async (field) => {
      await expect(
        createValidationPipe().transform(
          { ...validBody(), [field]: [] },
          {
            type: 'body',
            metatype: PublishTimetableDto,
          },
        ),
      ).rejects.toMatchObject({
        response: {
          message: [
            { field, rejectedValue: [], issueKey: 'ISSUE_LIST_TOO_SHORT' },
          ],
        },
      });
    },
  );

  it('names the full nested path for a malformed station identifier', async () => {
    const body = validBody();
    body.stops[0].stationId = 'unknown';

    await expect(
      createValidationPipe().transform(body, {
        type: 'body',
        metatype: PublishTimetableDto,
      }),
    ).rejects.toMatchObject({
      response: {
        message: expect.arrayContaining([
          expect.objectContaining({
            field: 'stops.0.stationId',
            rejectedValue: 'unknown',
            issueKey: 'ISSUE_MUST_BE_UUID',
          }),
        ]),
      },
    });
  });
});
