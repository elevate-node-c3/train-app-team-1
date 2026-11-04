import type { SearchOneWayTripsRequest } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  validateSearchReferences,
  validateSearchShape,
} from './trip-search-validation.js';

/** 12:00 Cairo. The window is 2026-06-15 .. 2026-07-14. */
const NOW = new Date('2026-06-15T09:00:00Z');

const CAIRO = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST_CLASS = '33333333-3333-4333-8333-333333333333';

const validRequest = (
  overrides: Partial<SearchOneWayTripsRequest> = {},
): SearchOneWayTripsRequest => ({
  originStationId: CAIRO,
  destinationStationId: ALEX,
  departureDate: '2026-06-20',
  travelClassId: FIRST_CLASS,
  ...overrides,
});

const fieldsOf = (details: { field: string }[]): string[] =>
  details.map((detail) => detail.field);

describe('validating the search request shape', () => {
  it('accepts a well-formed request', () => {
    expect(validateSearchShape(validRequest(), NOW)).toEqual([]);
  });

  it('names every refusal with a field and an action to take', () => {
    // BR-57: a refusal that does not say what to change is the failure this
    // rule exists to prevent.
    const details = validateSearchShape(
      validRequest({ originStationId: 'not-a-uuid', departureDate: 'nonsense' }),
      NOW,
    );

    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.field).not.toBe('');
      expect(detail.issue).not.toBe('');
      expect(detail.action).not.toBe('');
    }
  });

  describe('the stations', () => {
    it('refuses a missing or malformed station id', () => {
      expect(
        fieldsOf(validateSearchShape(validRequest({ originStationId: '' }), NOW)),
      ).toContain('from');
      expect(
        fieldsOf(
          validateSearchShape(
            validRequest({ destinationStationId: 'nope' }),
            NOW,
          ),
        ),
      ).toContain('to');
    });

    // The rule names To, so the refusal must too: a traveller told "from is
    // invalid" would change the wrong field.
    it('refuses the same station twice, naming To', () => {
      const details = validateSearchShape(
        validRequest({ destinationStationId: CAIRO }),
        NOW,
      );

      expect(fieldsOf(details)).toEqual(['to']);
      expect(details[0].rejectedValue).toBe(CAIRO);
    });
  });

  describe('the departure date', () => {
    it('refuses a date that is not YYYY-MM-DD', () => {
      expect(
        fieldsOf(
          validateSearchShape(validRequest({ departureDate: '20-06-2026' }), NOW),
        ),
      ).toEqual(['departureDate']);
    });

    // Review Focus 1: '2026-02-30' matches the pattern but is not a day. A
    // naive Date would roll it to 2 March and search the wrong date silently.
    it('refuses a date that passes the pattern but is not a real day', () => {
      for (const impossible of ['2026-02-30', '2026-13-01', '2026-04-31']) {
        expect(
          fieldsOf(
            validateSearchShape(
              validRequest({ departureDate: impossible }),
              NOW,
            ),
          ),
          `${impossible} should be refused`,
        ).toEqual(['departureDate']);
      }
    });

    it('accepts 29 February in a leap year and refuses it otherwise', () => {
      const leapNow = new Date('2028-02-01T09:00:00Z');

      expect(
        validateSearchShape(
          validRequest({ departureDate: '2028-02-29' }),
          leapNow,
        ),
      ).toEqual([]);
      expect(
        fieldsOf(
          validateSearchShape(
            validRequest({ departureDate: '2026-02-29' }),
            new Date('2026-02-01T09:00:00Z'),
          ),
        ),
      ).toEqual(['departureDate']);
    });

    it('refuses yesterday', () => {
      expect(
        fieldsOf(
          validateSearchShape(validRequest({ departureDate: '2026-06-14' }), NOW),
        ),
      ).toEqual(['departureDate']);
    });

    it('refuses a date past the window and states the last bookable one', () => {
      const details = validateSearchShape(
        validRequest({ departureDate: '2026-07-15' }),
        NOW,
      );

      expect(fieldsOf(details)).toEqual(['departureDate']);
      // The traveller needs the date to pick instead, not just a rejection.
      expect(details[0].action).toContain('2026-07-14');
    });

    it('accepts both ends of the window', () => {
      expect(
        validateSearchShape(validRequest({ departureDate: '2026-06-15' }), NOW),
      ).toEqual([]);
      expect(
        validateSearchShape(validRequest({ departureDate: '2026-07-14' }), NOW),
      ).toEqual([]);
    });
  });

  describe('the seat class', () => {
    it('refuses an absent class rather than defaulting to one', () => {
      // Every result's seats and fare are for one class, so there is no
      // sensible default to pick on the traveller's behalf.
      expect(
        fieldsOf(validateSearchShape(validRequest({ travelClassId: '' }), NOW)),
      ).toEqual(['travelClassId']);
    });
  });

  describe('the train number', () => {
    it('accepts an absent train number', () => {
      expect(validateSearchShape(validRequest(), NOW)).toEqual([]);
    });

    it('refuses a non-positive or non-integer train number', () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(
          fieldsOf(
            validateSearchShape(validRequest({ trainNumber: bad }), NOW),
          ),
          `${bad} should be refused`,
        ).toEqual(['trainNumber']);
      }
    });

    it('refuses Arabic-Indic digits, which the gateway normalizes first', () => {
      // Catalog only ever sees ASCII: the edge converts '٨٠٣' to 803. A
      // non-number arriving here means the edge was bypassed.
      expect(
        fieldsOf(
          validateSearchShape(
            validRequest({ trainNumber: '٨٠٣' as unknown as number }),
            NOW,
          ),
        ),
      ).toEqual(['trainNumber']);
    });
  });
});

describe('validating the search request against the catalogue', () => {
  const facts = {
    knownStationIds: new Set([CAIRO, ALEX]),
    activeStationIds: new Set([CAIRO, ALEX]),
    travelClassExists: true,
    trainExists: true,
  };

  it('accepts a request whose references all resolve', () => {
    expect(validateSearchReferences(validRequest(), facts)).toEqual([]);
  });

  // Review Focus 2: existence is a database fact a pattern check cannot know.
  it('refuses an unknown station, naming the side it came from', () => {
    const unknown = '44444444-4444-4444-8444-444444444444';

    expect(
      fieldsOf(
        validateSearchReferences(
          validRequest({ originStationId: unknown }),
          facts,
        ),
      ),
    ).toEqual(['from']);
    expect(
      fieldsOf(
        validateSearchReferences(
          validRequest({ destinationStationId: unknown }),
          facts,
        ),
      ),
    ).toEqual(['to']);
  });

  // An inactive station must refuse, not return an empty list: "no trains on
  // this date" would send the traveller to change the date forever.
  it('refuses a known but inactive station', () => {
    const details = validateSearchReferences(validRequest(), {
      ...facts,
      activeStationIds: new Set([ALEX]),
    });

    expect(fieldsOf(details)).toEqual(['from']);
    expect(details[0].issue).toContain('active');
  });

  it('refuses an unknown seat class', () => {
    expect(
      fieldsOf(
        validateSearchReferences(validRequest(), {
          ...facts,
          travelClassExists: false,
        }),
      ),
    ).toEqual(['travelClassId']);
  });

  it('refuses an unknown train number', () => {
    expect(
      fieldsOf(
        validateSearchReferences(validRequest({ trainNumber: 9999 }), {
          ...facts,
          trainExists: false,
        }),
      ),
    ).toEqual(['trainNumber']);
  });

  it('ignores the train flag when no train number was asked for', () => {
    expect(
      validateSearchReferences(validRequest(), {
        ...facts,
        trainExists: false,
      }),
    ).toEqual([]);
  });
});
