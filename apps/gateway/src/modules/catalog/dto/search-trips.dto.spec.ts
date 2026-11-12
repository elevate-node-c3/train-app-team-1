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
    expect(
      validate(validQuery({ departAfterMinutes: '360' })).fields,
    ).toContain('departAfterMinutes');
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

  describe('the return date', () => {
    it('is optional, and a one-way search simply omits it', () => {
      expect(validate(validQuery()).fields).toEqual([]);
      expect(validate(validQuery({ returnDate: '2026-06-25' })).fields).toEqual(
        [],
      );
    });

    it('requires YYYY-MM-DD form', () => {
      expect(validate(validQuery({ returnDate: '25-06-2026' })).fields).toEqual(
        ['returnDate'],
      );
    });

    // Whether it is on or after the departure date, and inside the booking
    // window, is BR-20 and therefore catalog's to answer.
    it('does not judge the date against the departure date', () => {
      expect(validate(validQuery({ returnDate: '2026-06-01' })).fields).toEqual(
        [],
      );
    });
  });

  describe('the sort order', () => {
    it('accepts each wire value', () => {
      for (const sort of [
        'SEARCH_SORT_DEPARTURE_ASC',
        'SEARCH_SORT_DURATION_ASC',
        'SEARCH_SORT_FARE_ASC',
        'SEARCH_SORT_ARRIVAL_ASC',
      ]) {
        expect(validate(validQuery({ sort })).fields, sort).toEqual([]);
      }
    });

    it('refuses an invented order rather than ignoring it', () => {
      // Silently falling back to the default would show the traveller a list
      // in an order they did not ask for.
      expect(validate(validQuery({ sort: 'cheapest' })).fields).toEqual([
        'sort',
      ]);
    });

    // UNSPECIFIED is the wire's way of saying "absent"; a client should omit
    // the parameter instead of naming the absence.
    it('refuses UNSPECIFIED, which is what absence already means', () => {
      expect(
        validate(validQuery({ sort: 'SEARCH_SORT_UNSPECIFIED' })).fields,
      ).toEqual(['sort']);
    });
  });

  describe('the train-type filter', () => {
    it('splits a CSV list into ids', () => {
      const { fields, dto } = validate(
        validQuery({ trainTypeIds: `${CAIRO},${ALEX}` }),
      );

      expect(fields).toEqual([]);
      expect(dto.trainTypeIds).toEqual([CAIRO, ALEX]);
    });

    it('accepts a single id', () => {
      const { dto } = validate(validQuery({ trainTypeIds: CAIRO }));

      expect(dto.trainTypeIds).toEqual([CAIRO]);
    });

    it('tolerates spaces around the commas', () => {
      const { dto } = validate(
        validQuery({ trainTypeIds: ` ${CAIRO} , ${ALEX} ` }),
      );

      expect(dto.trainTypeIds).toEqual([CAIRO, ALEX]);
    });

    it('treats an empty value as no preference', () => {
      const { fields, dto } = validate(validQuery({ trainTypeIds: '' }));

      // Not "a filter matching nothing", which would return an empty list.
      expect(fields).toEqual([]);
      expect(dto.trainTypeIds).toBeUndefined();
    });

    it('refuses the whole list when one id is malformed', () => {
      expect(
        validate(validQuery({ trainTypeIds: `${CAIRO},express` })).fields,
      ).toEqual(['trainTypeIds']);
    });
  });

  describe('the departure window', () => {
    it('converts a clock time to minutes since midnight', () => {
      const { fields, dto } = validate(
        validQuery({ departAfter: '06:00', departBefore: '12:30' }),
      );

      expect(fields).toEqual([]);
      expect(dto.departAfter).toBe(360);
      expect(dto.departBefore).toBe(750);
    });

    it('accepts midnight and the last minute of the day', () => {
      const { fields, dto } = validate(
        validQuery({ departAfter: '00:00', departBefore: '23:59' }),
      );

      expect(fields).toEqual([]);
      expect(dto.departAfter).toBe(0);
      expect(dto.departBefore).toBe(1439);
    });

    it('accepts Arabic-Indic digits in a time', () => {
      const { fields, dto } = validate(validQuery({ departAfter: '٠٦:٣٠' }));

      expect(fields).toEqual([]);
      expect(dto.departAfter).toBe(390);
    });

    it('refuses a time that is not a time', () => {
      for (const bad of ['6pm', '24:00', '12:60', '6:00', '0600', '']) {
        expect(
          validate(validQuery({ departAfter: bad })).fields,
          `${bad} should be refused`,
        ).toEqual(['departAfter']);
      }
    });

    // The ordering of the two bounds is BR-18 and catalog refuses it, naming
    // the field; the edge only checks that each one is a time.
    it('does not judge the two bounds against each other', () => {
      expect(
        validate(validQuery({ departAfter: '22:00', departBefore: '02:00' }))
          .fields,
      ).toEqual([]);
    });
  });

  describe('the maximum fare', () => {
    it('accepts piastres, including Arabic-Indic digits', () => {
      expect(validate(validQuery({ maxFare: '15500' })).dto.maxFare).toBe(
        15500,
      );
      expect(validate(validQuery({ maxFare: '١٥٥٠٠' })).dto.maxFare).toBe(
        15500,
      );
    });

    it('accepts zero, which is a ceiling nothing meets', () => {
      expect(validate(validQuery({ maxFare: '0' })).fields).toEqual([]);
    });

    it('refuses a negative, a decimal or a non-number', () => {
      for (const bad of ['-1', '155.50', 'cheap', '']) {
        expect(
          validate(validQuery({ maxFare: bad })).fields,
          `${bad} should be refused`,
        ).toEqual(['maxFare']);
      }
    });
  });

  describe('hiding sold-out trips', () => {
    it('accepts the two words', () => {
      expect(
        validate(validQuery({ excludeSoldOut: 'true' })).dto.excludeSoldOut,
      ).toBe(true);
      expect(
        validate(validQuery({ excludeSoldOut: 'false' })).dto.excludeSoldOut,
      ).toBe(false);
    });

    // 'no' is truthy as a string, so the usual coercion would hide exactly the
    // trips the traveller asked to see.
    it('refuses anything else rather than guessing', () => {
      for (const bad of ['no', 'yes', '1', '0', '']) {
        expect(
          validate(validQuery({ excludeSoldOut: bad })).fields,
          `${bad} should be refused`,
        ).toEqual(['excludeSoldOut']);
      }
    });
  });
});
