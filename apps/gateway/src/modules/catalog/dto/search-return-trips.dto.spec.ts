import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { SearchReturnTripsDto } from './search-return-trips.dto.js';
import { TripIdParamDto, TripStopsQueryDto } from './trip-stops.dto.js';
import { RecentSearchesQueryDto } from './recent-searches.dto.js';

const RAMSIS = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';
const TRIP = '44444444-4444-4444-8444-444444444444';

/** As the global pipe does it: plain query object in, validated class out. */
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

  /**
   * The two rules that must NOT be here. BR-20 says the server reads the
   * outbound trip's arrival itself, so there is no field for a client to send
   * one in; and a train number narrowed the outbound leg only.
   */
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
});

describe('the stops parameters', () => {
  it('requires both ends of the passenger segment', () => {
    const { fields } = validateAs(TripStopsQueryDto, { from: RAMSIS });

    // Not defaulted to the whole trip: this answers what the search result
    // offered, which is the passenger's own segment.
    expect(fields).toContain('to');
  });

  it('refuses the same station twice', () => {
    expect(
      validateAs(TripStopsQueryDto, { from: RAMSIS, to: RAMSIS }).fields,
    ).toEqual(['to']);
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

  /**
   * There is no account parameter and there will not be one: the traveller
   * comes from the verified token. `forbidNonWhitelisted` turns an attempt to
   * name one into a 400 rather than something quietly ignored.
   */
  it('refuses an attempt to name an account', () => {
    expect(
      validateAs(RecentSearchesQueryDto, {
        accountId: '55555555-5555-4555-8555-555555555555',
      }).fields,
    ).toContain('accountId');
  });
});
