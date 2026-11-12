import type { SearchOneWayTripsRequest } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  validateReturnDate,
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
      validRequest({
        originStationId: 'not-a-uuid',
        departureDate: 'nonsense',
      }),
      NOW,
    );

    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.field).not.toBe('');
      expect(detail.issueKey).toMatch(/^ISSUE_/);
      expect(detail.actionKey).toMatch(/^ACTION_/);
      expect(detail).not.toHaveProperty('issue');
      expect(detail).not.toHaveProperty('action');
    }
  });

  describe('the stations', () => {
    it('refuses a missing or malformed station id', () => {
      expect(
        fieldsOf(
          validateSearchShape(validRequest({ originStationId: '' }), NOW),
        ),
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
      expect(details[0]).toEqual({
        field: 'to',
        rejectedValue: CAIRO,
        issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
        actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
      });
    });
  });

  describe('the departure date', () => {
    it.each([
      ['20-06-2026', 'ISSUE_CIVIL_DATE_FORMAT'],
      ['2026-02-30', 'ISSUE_NOT_A_CALENDAR_DATE'],
    ])('keeps the distinct reason for %s', (departureDate, issueKey) => {
      expect(
        validateSearchShape(validRequest({ departureDate }), NOW)[0],
      ).toMatchObject({
        issueKey,
        actionKey: 'ACTION_PICK_DATE_FROM_CALENDAR',
      });
    });

    it('refuses a date that is not YYYY-MM-DD', () => {
      expect(
        fieldsOf(
          validateSearchShape(
            validRequest({ departureDate: '20-06-2026' }),
            NOW,
          ),
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
          validateSearchShape(
            validRequest({ departureDate: '2026-06-14' }),
            NOW,
          ),
        ),
      ).toEqual(['departureDate']);
    });

    it('preserves the past-date reason and the complete booking window as params', () => {
      expect(
        validateSearchShape(validRequest({ departureDate: '2026-06-14' }), NOW),
      ).toEqual([
        {
          field: 'departureDate',
          rejectedValue: '2026-06-14',
          issueKey: 'ISSUE_DATE_IN_THE_PAST',
          actionKey: 'ACTION_PICK_DATE_IN_BOOKING_WINDOW',
          params: {
            firstBookableDate: '2026-06-15',
            lastBookableDate: '2026-07-14',
          },
        },
      ]);
    });

    it('refuses a date past the window and states the last bookable one', () => {
      const details = validateSearchShape(
        validRequest({ departureDate: '2026-07-15' }),
        NOW,
      );

      expect(fieldsOf(details)).toEqual(['departureDate']);
      // The traveller needs the date to pick instead, not just a rejection.
      expect(details[0]).toMatchObject({
        issueKey: 'ISSUE_DATE_BEYOND_BOOKING_WINDOW',
        actionKey: 'ACTION_PICK_DATE_IN_BOOKING_WINDOW',
        params: {
          firstBookableDate: '2026-06-15',
          lastBookableDate: '2026-07-14',
        },
      });
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

  /**
   * The outbound search carries the return date so BR-20 can refuse it here,
   * one screen before the traveller would otherwise find out.
   */
  describe('the return date on an outbound search', () => {
    it('accepts an absent return date -- that is a one-way search', () => {
      expect(validateSearchShape(validRequest(), NOW)).toEqual([]);
    });

    it('accepts an empty string without reading it as a date', () => {
      // A client that always sends the field sends '' for one way.
      expect(
        validateSearchShape(validRequest({ returnDate: '' }), NOW),
      ).toEqual([]);
    });

    it('accepts a return date after the departure date', () => {
      expect(
        validateSearchShape(validRequest({ returnDate: '2026-06-25' }), NOW),
      ).toEqual([]);
    });

    // Out and back on one day is a round trip a traveller can make.
    it('accepts the same day as the departure date', () => {
      expect(
        validateSearchShape(validRequest({ returnDate: '2026-06-20' }), NOW),
      ).toEqual([]);
    });

    it('refuses a return date before the departure date, naming it', () => {
      const details = validateSearchShape(
        validRequest({ returnDate: '2026-06-19' }),
        NOW,
      );

      expect(fieldsOf(details)).toEqual(['returnDate']);
      // The action carries the date to pick instead, not just the complaint.
      expect(details[0]).toMatchObject({
        issueKey: 'ISSUE_RETURN_BEFORE_DEPARTURE',
        actionKey: 'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
        params: { departureDate: '2026-06-20' },
      });
    });

    it('refuses a return date past the booking window', () => {
      const details = validateSearchShape(
        validRequest({ returnDate: '2026-08-01' }),
        NOW,
      );

      expect(fieldsOf(details)).toEqual(['returnDate']);
      expect(details[0]).toMatchObject({
        issueKey: 'ISSUE_DATE_BEYOND_BOOKING_WINDOW',
        actionKey: 'ACTION_PICK_DATE_IN_BOOKING_WINDOW',
        params: {
          firstBookableDate: '2026-06-15',
          lastBookableDate: '2026-07-14',
        },
      });
    });

    it('refuses a malformed return date', () => {
      expect(
        fieldsOf(
          validateSearchShape(validRequest({ returnDate: '20-06-2026' }), NOW),
        ),
      ).toEqual(['returnDate']);
    });

    // A broken departure date must not produce a refusal pointing at the
    // return date: the traveller would go and change the wrong field.
    it('does not blame the return date for a broken departure date', () => {
      const details = validateSearchShape(
        validRequest({ departureDate: 'nonsense', returnDate: '2026-06-25' }),
        NOW,
      );

      expect(fieldsOf(details)).toEqual(['departureDate']);
    });
  });
});

describe('validating a return date (BR-20)', () => {
  it('refuses a date in the past before complaining about the order', () => {
    const details = validateReturnDate('2026-06-10', '2026-06-01', NOW);

    expect(fieldsOf(details)).toEqual(['returnDate']);
    expect(details[0]).toMatchObject({
      issueKey: 'ISSUE_DATE_IN_THE_PAST',
      actionKey: 'ACTION_PICK_DATE_IN_BOOKING_WINDOW',
      params: {
        firstBookableDate: '2026-06-15',
        lastBookableDate: '2026-07-14',
      },
    });
  });

  // The second leg calls this with the chosen trip's own departure date, which
  // the server read -- so the two legs cannot disagree about one return date.
  it('compares against whatever departure date the caller supplies', () => {
    expect(validateReturnDate('2026-06-21', '2026-06-20', NOW)).toEqual([]);
    expect(
      fieldsOf(validateReturnDate('2026-06-21', '2026-06-22', NOW)),
    ).toEqual(['returnDate']);
  });

  it('still refuses a malformed return date when the departure date is broken', () => {
    expect(fieldsOf(validateReturnDate('nope', 'nonsense', NOW))).toEqual([
      'returnDate',
    ]);
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
    expect(details[0]).toMatchObject({
      issueKey: 'ISSUE_STATION_NOT_ACTIVE',
      actionKey: 'ACTION_PICK_ANOTHER_STATION',
    });
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
