import type {
  SearchOneWayTripsRequest,
  ValidationErrorDetail,
} from '@app/contracts';
import {
  bookingWindowFor,
  cairoToday,
  isWithinBookingWindow,
} from '@app/contracts';

/**
 * Catalog's own refusals.
 *
 * The gateway validates the request shape too, but a gRPC peer is not a
 * trusted caller: anything that would produce a wrong answer is refused here
 * as well. Every refusal names the field to change and the change to make
 * (BR-57) -- the research finding behind that rule was travellers saying "I
 * don't know what to change: station, date, or round-trip option".
 *
 * `from` and `to` are the field names the traveller sees, not the wire's
 * `originStationId` / `destinationStationId`: the rule says the same-station
 * refusal names To, and the message has to match the form.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The identifier shape the catalogue mints; shared with the filter refusals. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** What the catalogue knows about the ids a request referenced. */
export interface SearchReferenceFacts {
  knownStationIds: Set<string>;
  activeStationIds: Set<string>;
  travelClassExists: boolean;
  /** Only meaningful when the request carried a train number. */
  trainExists: boolean;
}

/**
 * A date that matches the pattern but is not a day -- '2026-02-30' -- would be
 * rolled forward by `Date` into 2 March and would silently search a date the
 * traveller never asked for.
 */
function isRealCivilDate(value: string): boolean {
  if (!CIVIL_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const asDate = new Date(Date.UTC(year, month - 1, day));

  return (
    asDate.getUTCFullYear() === year &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day
  );
}

/** Rules that need nothing but the request and the clock. */
export function validateSearchShape(
  request: SearchOneWayTripsRequest,
  now: Date,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (const [field, value] of [
    ['from', request.originStationId],
    ['to', request.destinationStationId],
  ] as const) {
    if (!isUuid(value)) {
      details.push({
        field,
        rejectedValue: value,
        issue: 'is not a known station identifier',
        action: 'Pick a station from the station list',
      });
    }
  }

  // Only worth saying once the two are individually well-formed, and named
  // against To because that is the one the traveller should change.
  if (
    details.length === 0 &&
    request.originStationId === request.destinationStationId
  ) {
    details.push({
      field: 'to',
      rejectedValue: request.destinationStationId,
      issue: 'is the same station as From',
      action: 'Pick a different destination station',
    });
  }

  if (!isUuid(request.travelClassId)) {
    details.push({
      field: 'travelClassId',
      rejectedValue: request.travelClassId,
      // Not defaulted: every result's seats and fare are for one class, so
      // there is no class the server could pick on the traveller's behalf.
      issue: 'is required, and must be one of the offered seat classes',
      action: 'Choose a seat class',
    });
  }

  details.push(...validateDepartureDate(request.departureDate, now));

  // Only when the traveller is planning a round trip. Checked against the date
  // they typed, which is the only departure date this call knows; the second
  // leg re-checks it against the chosen trip's own departure date, which is the
  // server's.
  if (request.returnDate !== undefined && request.returnDate !== '') {
    details.push(
      ...validateReturnDate(request.returnDate, request.departureDate, now),
    );
  }

  if (request.trainNumber !== undefined) {
    const trainNumber = request.trainNumber;
    if (
      typeof trainNumber !== 'number' ||
      !Number.isInteger(trainNumber) ||
      trainNumber <= 0
    ) {
      details.push({
        field: 'trainNumber',
        rejectedValue: trainNumber,
        issue: 'is not a train number',
        action: 'Enter a train number, or clear it to see every train',
      });
    }
  }

  return details;
}

function validateDepartureDate(
  departureDate: string,
  now: Date,
): ValidationErrorDetail[] {
  if (!isRealCivilDate(departureDate ?? '')) {
    return [
      {
        field: 'departureDate',
        rejectedValue: departureDate,
        issue: 'is not a calendar date in YYYY-MM-DD form',
        action: 'Pick a date from the calendar',
      },
    ];
  }

  if (isWithinBookingWindow(departureDate, now)) return [];

  const { firstBookableDate, lastBookableDate } = bookingWindowFor(now);
  const inThePast = departureDate < cairoToday(now);

  return [
    {
      field: 'departureDate',
      rejectedValue: departureDate,
      issue: inThePast
        ? 'is in the past'
        : 'is beyond the dates currently open for booking',
      // The last bookable date belongs in the action: a traveller needs the
      // date to pick instead, not only the news that this one is wrong.
      action: `Pick a date between ${firstBookableDate} and ${lastBookableDate}`,
    },
  ];
}

/**
 * A round trip's return date (BR-20).
 *
 * Exported because both legs ask it and must agree: the outbound search checks
 * it against the departure date the traveller typed, and the return search
 * checks it again against the chosen trip's own Cairo departure date, which the
 * server reads rather than trusts. One function means the two can never answer
 * differently -- a return date accepted on the first screen and refused on the
 * second would be the worst of both.
 *
 * `departureDate` is assumed already validated by the caller; when it is not a
 * date at all the comparison is skipped, because a refusal naming the return
 * date for a broken departure date would send the traveller to the wrong field.
 */
export function validateReturnDate(
  returnDate: string,
  departureDate: string,
  now: Date,
): ValidationErrorDetail[] {
  if (!isRealCivilDate(returnDate ?? '')) {
    return [
      {
        field: 'returnDate',
        rejectedValue: returnDate,
        issue: 'is not a calendar date in YYYY-MM-DD form',
        action: 'Pick a return date from the calendar',
      },
    ];
  }

  // On or after, not strictly after: out and back on one day is a round trip a
  // traveller can and does make.
  if (isRealCivilDate(departureDate ?? '') && returnDate < departureDate) {
    return [
      {
        field: 'returnDate',
        rejectedValue: returnDate,
        issue: 'is before the departure date',
        action: `Pick a return date on or after ${departureDate}`,
      },
    ];
  }

  if (isWithinBookingWindow(returnDate, now)) return [];

  const { firstBookableDate, lastBookableDate } = bookingWindowFor(now);

  return [
    {
      field: 'returnDate',
      rejectedValue: returnDate,
      issue:
        returnDate < cairoToday(now)
          ? 'is in the past'
          : 'is beyond the dates currently open for booking',
      action: `Pick a date between ${firstBookableDate} and ${lastBookableDate}`,
    },
  ];
}

/**
 * Rules that need the catalogue. Kept separate and pure so the decisions stay
 * unit-testable, with `CatalogReferenceRepository` supplying the facts -- the
 * same seam `emptyReasonFor` uses for the probes.
 */
export function validateSearchReferences(
  request: SearchOneWayTripsRequest,
  facts: SearchReferenceFacts,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (const [field, stationId] of [
    ['from', request.originStationId],
    ['to', request.destinationStationId],
  ] as const) {
    if (!facts.knownStationIds.has(stationId)) {
      details.push({
        field,
        rejectedValue: stationId,
        issue: 'is not a station in the network',
        action: 'Pick a station from the station list',
      });
      continue;
    }

    // Refused rather than answered with an empty list: "no trains on this
    // date" would send the traveller to change the date, forever, for a
    // station that is never going to return a trip.
    if (!facts.activeStationIds.has(stationId)) {
      details.push({
        field,
        rejectedValue: stationId,
        issue: 'is not an active station',
        action: 'Pick another station from the station list',
      });
    }
  }

  if (!facts.travelClassExists) {
    details.push({
      field: 'travelClassId',
      rejectedValue: request.travelClassId,
      issue: 'is not an offered seat class',
      action: 'Choose a seat class from the list',
    });
  }

  if (request.trainNumber !== undefined && !facts.trainExists) {
    details.push({
      field: 'trainNumber',
      rejectedValue: request.trainNumber,
      issue: 'is not a train number in service',
      action: 'Check the number, or clear it to see every train',
    });
  }

  return details;
}
