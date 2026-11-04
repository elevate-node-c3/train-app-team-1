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
    if (!UUID_PATTERN.test(value ?? '')) {
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

  if (!UUID_PATTERN.test(request.travelClassId ?? '')) {
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
