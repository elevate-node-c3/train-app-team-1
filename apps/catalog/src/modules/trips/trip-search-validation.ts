import { isRfcUuid } from '@app/common/validation/uuid.js';
import type {
  SearchOneWayTripsRequest,
  ValidationIssueRef,
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

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The identifier shape the catalogue mints; shared with the filter refusals. */
export function isUuid(value: unknown): value is string {
  return isRfcUuid(value);
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
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

  for (const [field, value] of [
    ['from', request.originStationId],
    ['to', request.destinationStationId],
  ] as const) {
    if (!isUuid(value)) {
      details.push({
        field,
        rejectedValue: value,
        issueKey: 'ISSUE_STATION_NOT_KNOWN',
        actionKey: 'ACTION_PICK_STATION_FROM_LIST',
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
      issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
      actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
    });
  }

  if (!isUuid(request.travelClassId)) {
    details.push({
      field: 'travelClassId',
      rejectedValue: request.travelClassId,
      // Not defaulted: every result's seats and fare are for one class, so
      // there is no class the server could pick on the traveller's behalf.
      issueKey: 'ISSUE_SEAT_CLASS_REQUIRED',
      actionKey: 'ACTION_PICK_SEAT_CLASS',
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
        issueKey: 'ISSUE_TRAIN_NUMBER_NOT_KNOWN',
        actionKey: 'ACTION_FIX_OR_CLEAR_TRAIN_NUMBER',
      });
    }
  }

  return details;
}

function validateDepartureDate(
  departureDate: string,
  now: Date,
): ValidationIssueRef[] {
  if (!isRealCivilDate(departureDate ?? '')) {
    return [
      {
        field: 'departureDate',
        rejectedValue: departureDate,
        issueKey: CIVIL_DATE_PATTERN.test(departureDate ?? '')
          ? 'ISSUE_NOT_A_CALENDAR_DATE'
          : 'ISSUE_CIVIL_DATE_FORMAT',
        actionKey: 'ACTION_PICK_DATE_FROM_CALENDAR',
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
      issueKey: inThePast
        ? 'ISSUE_DATE_IN_THE_PAST'
        : 'ISSUE_DATE_BEYOND_BOOKING_WINDOW',
      // The last bookable date belongs in the action: a traveller needs the
      // date to pick instead, not only the news that this one is wrong.
      actionKey: 'ACTION_PICK_DATE_IN_BOOKING_WINDOW',
      params: { firstBookableDate, lastBookableDate },
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
): ValidationIssueRef[] {
  if (!isRealCivilDate(returnDate ?? '')) {
    return [
      {
        field: 'returnDate',
        rejectedValue: returnDate,
        issueKey: CIVIL_DATE_PATTERN.test(returnDate ?? '')
          ? 'ISSUE_NOT_A_CALENDAR_DATE'
          : 'ISSUE_CIVIL_DATE_FORMAT',
        actionKey: 'ACTION_PICK_RETURN_DATE_FROM_CALENDAR',
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
        issueKey: 'ISSUE_RETURN_BEFORE_DEPARTURE',
        actionKey: 'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
        params: { departureDate },
      },
    ];
  }

  if (isWithinBookingWindow(returnDate, now)) return [];

  const { firstBookableDate, lastBookableDate } = bookingWindowFor(now);

  return [
    {
      field: 'returnDate',
      rejectedValue: returnDate,
      issueKey:
        returnDate < cairoToday(now)
          ? 'ISSUE_DATE_IN_THE_PAST'
          : 'ISSUE_DATE_BEYOND_BOOKING_WINDOW',
      actionKey: 'ACTION_PICK_DATE_IN_BOOKING_WINDOW',
      params: { firstBookableDate, lastBookableDate },
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
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

  for (const [field, stationId] of [
    ['from', request.originStationId],
    ['to', request.destinationStationId],
  ] as const) {
    if (!facts.knownStationIds.has(stationId)) {
      details.push({
        field,
        rejectedValue: stationId,
        issueKey: 'ISSUE_STATION_NOT_KNOWN',
        actionKey: 'ACTION_PICK_STATION_FROM_LIST',
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
        issueKey: 'ISSUE_STATION_NOT_ACTIVE',
        actionKey: 'ACTION_PICK_ANOTHER_STATION',
      });
    }
  }

  if (!facts.travelClassExists) {
    details.push({
      field: 'travelClassId',
      rejectedValue: request.travelClassId,
      issueKey: 'ISSUE_SEAT_CLASS_NOT_OFFERED',
      actionKey: 'ACTION_PICK_SEAT_CLASS_FROM_LIST',
    });
  }

  if (request.trainNumber !== undefined && !facts.trainExists) {
    details.push({
      field: 'trainNumber',
      rejectedValue: request.trainNumber,
      issueKey: 'ISSUE_TRAIN_NUMBER_NOT_IN_SERVICE',
      actionKey: 'ACTION_FIX_OR_CLEAR_TRAIN_NUMBER',
    });
  }

  return details;
}
