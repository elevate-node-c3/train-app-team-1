import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { createValidationPipe } from '@app/common';

import { SearchReturnTripsDto } from './search-return-trips.dto.js';
import { TripIdParamDto, TripStopsQueryDto } from './trip-stops.dto.js';
import { RecentSearchesQueryDto } from './recent-searches.dto.js';

const RAMSIS = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';
const TRIP = '44444444-4444-4444-8444-444444444444';

/** Validate queries like the global pipe. */
function validateAs<T extends object>(
  cls: new () => T,
  query: Record<string, unknown>,
): { fields: string[]; dto: T } {
  const dto = plainToInstance(cls, query, { enableImplicitConversion: false });
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return { fields: errors.map((error) => error.property), dto };
}

describe('the return-search query parameters', () => {
  const validQuery = (overrides: Record<string, unknown> = {}) => ({
    outboundTripId: TRIP,
    outboundFrom: RAMSIS,
    outboundTo: ALEX,
    returnDate: '2026-06-25',
    travelClassId: FIRST,
    ...overrides,
  });

  const validate = (query: Record<string, unknown>) =>
    validateAs(SearchReturnTripsDto, query);

  it('accepts a well-formed return search', () => {
    expect(validate(validQuery()).fields).toEqual([]);
  });

  it('requires the chosen outbound trip and its two stations', () => {
    for (const field of [
      'outboundTripId',
      'outboundFrom',
      'outboundTo',
    ] as const) {
      expect(
        validate(validQuery({ [field]: undefined })).fields,
        `${field} should be required`,
      ).toContain(field);
    }
  });

  it('refuses the same station twice, against the destination', () => {
    expect(validate(validQuery({ outboundTo: RAMSIS })).fields).toEqual([
      'outboundTo',
    ]);
  });

  it('requires a return date in YYYY-MM-DD form', () => {
    expect(validate(validQuery({ returnDate: '25-06-2026' })).fields).toEqual([
      'returnDate',
    ]);
    expect(validate(validQuery({ returnDate: undefined })).fields).toEqual([
      'returnDate',
    ]);
  });

  /** Arrival time is server-owned; train numbers narrow only the outbound search. */
  it('has no field for an arrival time or a train number', () => {
    expect(
      validate(validQuery({ outboundArrivalAt: '2026-06-25T23:50:00Z' }))
        .fields,
    ).toContain('outboundArrivalAt');
    expect(validate(validQuery({ trainNumber: '903' })).fields).toContain(
      'trainNumber',
    );
  });

  it('takes the same filters and order as the outbound leg', () => {
    const { fields, dto } = validate(
      validQuery({
        sort: 'SEARCH_SORT_DURATION_ASC',
        trainTypeIds: `${FIRST},${TRIP}`,
        departAfter: '06:00',
        departBefore: '٢٣:٣٠',
        maxFare: '١٥٥٠٠',
        excludeSoldOut: 'true',
      }),
    );

    expect(fields).toEqual([]);
    expect(dto.sort).toBe('SEARCH_SORT_DURATION_ASC');
    expect(dto.trainTypeIds).toEqual([FIRST, TRIP]);
    expect(dto.departAfter).toBe(360);
    expect(dto.departBefore).toBe(1410);
    expect(dto.maxFare).toBe(15500);
    expect(dto.excludeSoldOut).toBe(true);
  });

  it('refuses a malformed filter the same way the outbound leg does', () => {
    expect(validate(validQuery({ departAfter: '6pm' })).fields).toEqual([
      'departAfter',
    ]);
    expect(validate(validQuery({ sort: 'cheapest' })).fields).toEqual(['sort']);
  });

  it.each([
    {
      field: 'returnDate',
      value: '25-06-2026',
      issueKey: 'ISSUE_CIVIL_DATE_FORMAT',
    },
    { field: 'sort', value: 'cheapest', issueKey: 'ISSUE_SORT_NOT_OFFERED' },
    {
      field: 'trainTypeIds',
      value: 'express',
      issueKey: 'ISSUE_TRAIN_TYPE_LIST_MALFORMED',
    },
    {
      field: 'departAfter',
      value: '24:00',
      issueKey: 'ISSUE_CLOCK_TIME_FORMAT',
    },
    {
      field: 'departBefore',
      value: '24:00',
      issueKey: 'ISSUE_CLOCK_TIME_FORMAT',
    },
    { field: 'maxFare', value: 0.5, issueKey: 'ISSUE_FARE_NOT_A_NUMBER' },
    { field: 'maxFare', value: -1, issueKey: 'ISSUE_FARE_NEGATIVE' },
    {
      field: 'excludeSoldOut',
      value: 'yes',
      issueKey: 'ISSUE_MUST_BE_YES_OR_NO',
    },
  ])(
    '$field keeps $issueKey through the real pipe',
    async ({ field, value, issueKey }) => {
      await expect(
        createValidationPipe().transform(validQuery({ [field]: value }), {
          type: 'query',
          metatype: SearchReturnTripsDto,
        }),
      ).rejects.toMatchObject({
        response: {
          message: expect.arrayContaining([
            expect.objectContaining({ field, issueKey }),
          ]),
        },
      });
    },
  );

  it('keeps the custom outbound same-station issue and corrective action through the real pipe', async () => {
    await expect(
      createValidationPipe().transform(validQuery({ outboundTo: RAMSIS }), {
        type: 'query',
        metatype: SearchReturnTripsDto,
      }),
    ).rejects.toMatchObject({
      response: {
        message: [
          {
            field: 'outboundTo',
            rejectedValue: RAMSIS,
            issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
            actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
          },
        ],
      },
    });
  });
});

describe('the stops parameters', () => {
  it('requires both ends of the passenger segment', () => {
    const { fields } = validateAs(TripStopsQueryDto, { from: RAMSIS });

    // Use the passenger's segment, not the whole trip.
    expect(fields).toContain('to');
  });

  it('refuses the same station twice', () => {
    expect(
      validateAs(TripStopsQueryDto, { from: RAMSIS, to: RAMSIS }).fields,
    ).toEqual(['to']);
  });

  it('keeps the custom segment same-station issue and corrective action through the real pipe', async () => {
    await expect(
      createValidationPipe().transform(
        { from: RAMSIS, to: RAMSIS },
        {
          type: 'query',
          metatype: TripStopsQueryDto,
        },
      ),
    ).rejects.toMatchObject({
      response: {
        message: [
          {
            field: 'to',
            rejectedValue: RAMSIS,
            issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
            actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
          },
        ],
      },
    });
  });

  it('accepts a well-formed pair and an optional language', () => {
    expect(
      validateAs(TripStopsQueryDto, { from: RAMSIS, to: ALEX, language: 'en' })
        .fields,
    ).toEqual([]);
  });

  it('requires the path trip id to be a uuid', () => {
    expect(validateAs(TripIdParamDto, { tripId: 'trip-1' }).fields).toEqual([
      'tripId',
    ]);
    expect(validateAs(TripIdParamDto, { tripId: TRIP }).fields).toEqual([]);
  });
});

describe('the recent-searches parameters', () => {
  it('takes nothing but a language preference', () => {
    expect(validateAs(RecentSearchesQueryDto, {}).fields).toEqual([]);
    expect(
      validateAs(RecentSearchesQueryDto, { language: 'ar' }).fields,
    ).toEqual([]);
  });

  /** Account IDs come from the verified token; query overrides are rejected. */
  it('refuses an attempt to name an account', () => {
    expect(
      validateAs(RecentSearchesQueryDto, {
        accountId: '55555555-5555-4555-8555-555555555555',
      }).fields,
    ).toContain('accountId');
  });
});
