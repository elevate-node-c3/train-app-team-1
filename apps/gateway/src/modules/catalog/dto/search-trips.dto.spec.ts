import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { SearchTripsDto } from './search-trips.dto.js';

const CAIRO = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';

/** As the global pipe does it: plain query object in, validated class out. */
function validate(query: Record<string, unknown>): {
  fields: string[];
  dto: SearchTripsDto;
} {
  const dto = plainToInstance(SearchTripsDto, query, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return { fields: errors.map((error) => error.property), dto };
}

const validQuery = (overrides: Record<string, unknown> = {}) => ({
  from: CAIRO,
  to: ALEX,
  departureDate: '2026-06-20',
  travelClassId: FIRST,
  ...overrides,
});

describe('the search query parameters', () => {
  it('accepts a well-formed search', () => {
    expect(validate(validQuery()).fields).toEqual([]);
  });

  it('requires both stations as uuids', () => {
    expect(validate(validQuery({ from: 'ramsis' })).fields).toContain('from');
    expect(validate(validQuery({ to: undefined })).fields).toContain('to');
  });

  // The rule names To, so the refusal must too.
  it('refuses the same station twice, against To', () => {
    expect(validate(validQuery({ to: CAIRO })).fields).toEqual(['to']);
  });

  it('requires a date in YYYY-MM-DD form', () => {
    for (const bad of ['20-06-2026', '2026/06/20', 'tomorrow', '']) {
      expect(
        validate(validQuery({ departureDate: bad })).fields,
        `${bad} should be refused`,
      ).toContain('departureDate');
    }
  });

  // Whether the date is bookable is catalog's to answer -- the edge only
  // checks the shape, so a valid-looking future date passes here.
  it('does not judge whether the date is bookable', () => {
    expect(validate(validQuery({ departureDate: '2030-01-01' })).fields).toEqual(
      [],
    );
  });

  it('requires a seat class', () => {
    expect(validate(validQuery({ travelClassId: undefined })).fields).toContain(
      'travelClassId',
    );
  });

  it('rejects an unknown query parameter', () => {
    // forbidNonWhitelisted, so a typo in a parameter name is a 400 rather
    // than a silently ignored filter.
    expect(validate(validQuery({ returnDate: '2026-06-25' })).fields).toContain(
      'returnDate',
    );
  });

  describe('the train number', () => {
    it('is optional', () => {
      expect(validate(validQuery()).fields).toEqual([]);
    });

    it('accepts an ASCII number', () => {
      const { fields, dto } = validate(validQuery({ trainNumber: '903' }));

      expect(fields).toEqual([]);
      expect(dto.trainNumber).toBe(903);
    });

    // A traveller on an Arabic keyboard types ٨٠٣, and the rule says that is
    // a valid train number. Normalized here so catalog only sees ASCII.
    it('accepts Arabic-Indic digits and normalizes them', () => {
      const { fields, dto } = validate(validQuery({ trainNumber: '٩٠٣' }));

      expect(fields).toEqual([]);
      expect(dto.trainNumber).toBe(903);
    });

    it('accepts Persian digits too, which Arabic keyboards also produce', () => {
      const { dto } = validate(validQuery({ trainNumber: '۹۰۳' }));

      expect(dto.trainNumber).toBe(903);
    });

    it('refuses a non-number rather than passing NaN on', () => {
      for (const bad of ['abc', '9o3', '', '12.5']) {
        expect(
          validate(validQuery({ trainNumber: bad })).fields,
          `${bad} should be refused`,
        ).toContain('trainNumber');
      }
    });

    it('refuses zero and negatives, which are not train numbers', () => {
      expect(validate(validQuery({ trainNumber: '0' })).fields).toContain(
        'trainNumber',
      );
      expect(validate(validQuery({ trainNumber: '-5' })).fields).toContain(
        'trainNumber',
      );
    });
  });

  describe('the language preference', () => {
    it('is optional and limited to the two supported', () => {
      expect(validate(validQuery({ language: 'en' })).fields).toEqual([]);
      expect(validate(validQuery({ language: 'ar' })).fields).toEqual([]);
      expect(validate(validQuery({ language: 'fr' })).fields).toContain(
        'language',
      );
    });
  });
});
