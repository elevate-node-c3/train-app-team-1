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
 * Revalidate gRPC requests; gateway validation does not make peers trusted.
 * Every refusal names a field and an action. Use form names from/to, not wire
 * originStationId/destinationStationId; same-station refusals must name To.
 */

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The identifier shape the catalogue mints; shared with the filter refusals. */
export function isUuid(value: unknown): value is string {
  return isRfcUuid(value);
}

export interface SearchReferenceFacts {
  knownStationIds: Set<string>;
  activeStationIds: Set<string>;
  travelClassExists: boolean;
  /** Only meaningful when the request carried a train number. */
  trainExists: boolean;
}

/** Reject impossible dates instead of letting Date roll them into another month. */
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

/** Validate syntax and date-window rules before catalog queries. */
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

  // Report equal stations against To, only after both IDs validate.
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

  // Validate against the requested departure here; return search rechecks against
  // the server-read outbound departure date.
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
 * Share return-date rules across both legs. Outbound uses the requested departure;
 * return search uses the server-read trip's Cairo departure date.
 * Callers validate departure first; skip comparison if it is malformed to avoid
 * blaming returnDate for a departure-date fault.
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

  // Same-day returns are allowed; use on-or-after, not strictly after.
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

/** Validate catalog facts separately from shape and clock rules. */
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

    // Refuse inactive stations; changing the date cannot make them serve a trip.
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
