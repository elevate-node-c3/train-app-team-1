import type { ValidationErrorDetail } from '@app/contracts';
import { addCivilDays, cairoInstantOf } from '@app/contracts';

import type { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import type { FareIndex, TripStopDraft } from '../trips/trip-generation.types.js';
import { fareKey } from '../trips/trip-generation.types.js';
import { isChargeableFare } from '../../config/operations-settings.js';

/**
 * A publish candidate's view of one stop, before it is resolved onto any
 * service date. `'HH:mm'`, not a `Date`: an operator submits a timetable, not
 * a day's trip.
 */
export interface TimetableStopDraftInput {
  stationId: string;
  position: number;
  dayOffset: number;
  arrivalTime: string | null;
  departureTime: string | null;
}

/**
 * Everything one publish refusal needs to check, in one place, so a problem
 * on stop 14 of 15 cannot hide the other four.
 */
export interface TimetableCandidate {
  stops: TimetableStopDraftInput[];
  coaches: TrainCoachEntity[];
  fares: FareIndex;
  knownStationIds: ReadonlySet<string>;
  knownCoachLayoutIds: ReadonlySet<string>;
  effectiveFrom: string;
}

/** A stop resolved onto real instants, independent of how it got there. */
interface ResolvedStop {
  stationId: string;
  arrivalAt: Date | null;
  departureAt: Date | null;
}

/**
 * The one entry point generation and publish both end at. Collects, never
 * throws -- an operator refused on the 14th of 15 stops still needs to hear
 * about the other four in the same answer.
 */
export function validateTimetableCandidate(
  candidate: TimetableCandidate,
): ValidationErrorDetail[] {
  const resolvedStops = resolveStopInstants(
    candidate.stops,
    candidate.effectiveFrom,
  );

  return [
    ...validateStopsStructure(candidate.stops, candidate.knownStationIds),
    ...validateStopsChronology(resolvedStops),
    ...validateFareRules(candidate.coaches, resolvedStops, candidate.fares),
    ...validateCapacityIssues(candidate.coaches, candidate.knownCoachLayoutIds),
  ];
}

/** Same math `buildTripStops` uses, so a candidate and a generated trip agree. */
function resolveStopInstants(
  stops: TimetableStopDraftInput[],
  effectiveFrom: string,
): ResolvedStop[] {
  return stops.map((stop) => {
    const stopDate = addCivilDays(effectiveFrom, stop.dayOffset);

    return {
      stationId: stop.stationId,
      arrivalAt: stop.arrivalTime
        ? cairoInstantOf(stopDate, stop.arrivalTime)
        : null,
      departureAt: stop.departureTime
        ? cairoInstantOf(stopDate, stop.departureTime)
        : null,
    };
  });
}

/**
 * The route's shape: enough stops, the right ends, every id real and used
 * once, positions and day offsets that never go backwards. Nothing here
 * touches a clock reading -- that is `validateStopsChronology`'s job.
 */
export function validateStopsStructure(
  stops: TimetableStopDraftInput[],
  knownStationIds: ReadonlySet<string>,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  if (stops.length < 2) {
    details.push({
      field: 'stops',
      rejectedValue: stops.length,
      issue: 'must have at least two stops',
      action: 'Add stops until the route has at least two',
    });
    return details;
  }

  const lastIndex = stops.length - 1;
  const firstStop = stops[0];
  const lastStop = stops[lastIndex];

  if (firstStop.arrivalTime !== null) {
    details.push({
      field: 'stops[0].arrivalTime',
      rejectedValue: firstStop.arrivalTime,
      issue: 'First stop must not have arrival time',
      action: 'Clear the arrival time on the first stop',
    });
  }

  if (!firstStop.departureTime) {
    details.push({
      field: 'stops[0].departureTime',
      rejectedValue: firstStop.departureTime,
      issue: 'First stop must have departure time',
      action: 'Set a departure time on the first stop',
    });
  }

  if (!lastStop.arrivalTime) {
    details.push({
      field: `stops[${lastIndex}].arrivalTime`,
      rejectedValue: lastStop.arrivalTime,
      issue: 'Last stop must have arrival time',
      action: 'Set an arrival time on the last stop',
    });
  }

  if (lastStop.departureTime !== null) {
    details.push({
      field: `stops[${lastIndex}].departureTime`,
      rejectedValue: lastStop.departureTime,
      issue: 'Last stop must not have departure time',
      action: 'Clear the departure time on the last stop',
    });
  }

  for (let i = 1; i < lastIndex; i++) {
    const stop = stops[i];

    if (!stop.arrivalTime) {
      details.push({
        field: `stops[${i}].arrivalTime`,
        rejectedValue: stop.arrivalTime,
        issue: 'Intermediate stop must have arrival and departure times',
        action: 'Set an arrival time on this stop',
      });
    }

    if (!stop.departureTime) {
      details.push({
        field: `stops[${i}].departureTime`,
        rejectedValue: stop.departureTime,
        issue: 'Intermediate stop must have arrival and departure times',
        action: 'Set a departure time on this stop',
      });
    }
  }

  for (let i = 1; i < stops.length; i++) {
    if (stops[i].position <= stops[i - 1].position) {
      details.push({
        field: `stops[${i}].position`,
        rejectedValue: stops[i].position,
        issue: 'Timetable stops are not correctly ordered',
        action: 'Renumber stop positions so they strictly increase',
      });
    }

    if (stops[i].dayOffset < stops[i - 1].dayOffset) {
      details.push({
        field: `stops[${i}].dayOffset`,
        rejectedValue: stops[i].dayOffset,
        issue: 'Timetable day offset cannot go backwards',
        action: 'Fix the day offset so it never decreases along the route',
      });
    }
  }

  // Station identity, last: an id that is not even real is a worse problem
  // than its position, but reporting both costs nothing.
  const seenAt = new Map<string, number>();

  for (let i = 0; i < stops.length; i++) {
    const stationId = stops[i].stationId;

    if (!knownStationIds.has(stationId)) {
      details.push({
        field: `stops[${i}].stationId`,
        rejectedValue: stationId,
        issue: 'is not a known station',
        action: 'Choose a station from the station list',
      });
      continue;
    }

    const firstSeenAt = seenAt.get(stationId);

    if (firstSeenAt !== undefined) {
      details.push({
        field: `stops[${i}].stationId`,
        rejectedValue: stationId,
        issue: `is the same station as stop ${firstSeenAt}`,
        action: 'Remove the duplicate stop, or choose a different station',
      });
    } else {
      seenAt.set(stationId, i);
    }
  }

  return details;
}

/**
 * Real clock order: a stop's own departure must not precede its arrival, and
 * each stop must not precede the one before it. Works from resolved instants
 * so generation (already-resolved dates) and publish (resolved here from
 * `effectiveFrom`) share the same check.
 */
export function validateStopsChronology(
  stops: ResolvedStop[],
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (let i = 0; i < stops.length; i++) {
    const current = stops[i];

    if (
      current.arrivalAt &&
      current.departureAt &&
      current.departureAt.getTime() < current.arrivalAt.getTime()
    ) {
      details.push({
        field: `stops[${i}].departureTime`,
        rejectedValue: current.departureAt.toISOString(),
        issue: 'Departure cannot be before arrival',
        action: 'Fix the departure time so it is not before the arrival time',
      });
    }

    if (i === 0) continue;

    const previous = stops[i - 1];

    if (!previous.departureAt || !current.arrivalAt) {
      details.push({
        field: `stops[${i}].arrivalTime`,
        rejectedValue: current.arrivalAt,
        issue: 'Invalid trip stop times',
        action: 'Set arrival and departure times for every intermediate stop',
      });
      continue;
    }

    if (current.arrivalAt.getTime() < previous.departureAt.getTime()) {
      details.push({
        field: `stops[${i}].arrivalTime`,
        rejectedValue: current.arrivalAt.toISOString(),
        issue: 'Trip stops are not in chronological order',
        action: 'Fix the times so each stop follows the one before it',
      });
    }
  }

  return details;
}

function resolveFareAmount(
  fares: FareIndex,
  travelClassId: string,
  originStationId: string,
  destinationStationId: string,
  asOf: Date,
): number | null {
  const prices = fares.get(
    fareKey(travelClassId, originStationId, destinationStationId),
  );

  const price = prices?.find(
    (candidate) => candidate.effectiveFrom.getTime() <= asOf.getTime(),
  );

  if (!price) return null;

  if (!Number.isSafeInteger(price.amountPiastres) || price.amountPiastres <= 0) {
    return null;
  }

  return price.amountPiastres;
}

/**
 * Every in-order pair, for every class, must have one positive fare; a
 * longer segment must never cost less than one it contains (CAT-2); and the
 * cheapest purchasable thing in each class must clear Stripe's floor (§6.3).
 *
 * Comparing each pair with the pair one stop shorter at either end is
 * enough for containment -- it follows by shrinking one end at a time.
 */
export function validateFareRules(
  coaches: TrainCoachEntity[],
  stops: ResolvedStop[],
  fares: FareIndex,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  const travelClassIds = [
    ...new Set(coaches.map((coach) => coach.travelClass.id)),
  ];

  if (travelClassIds.length === 0) {
    details.push({
      field: 'coaches',
      rejectedValue: coaches.length,
      issue: 'Train has no travel classes',
      action: 'Add a coach with a travel class before publishing fares',
    });
    return details;
  }

  if (stops.length < 2) {
    details.push({
      field: 'stops',
      rejectedValue: stops.length,
      issue: 'Trip must have at least two stops',
      action: 'Add stops until the route has at least two',
    });
    return details;
  }

  for (const travelClassId of travelClassIds) {
    const amounts = new Map<string, number>();
    let cheapest: { field: string; amount: number } | null = null;

    for (let i = 0; i < stops.length - 1; i++) {
      const origin = stops[i];

      if (!origin.departureAt) {
        details.push({
          field: `stops[${i}].departureTime`,
          rejectedValue: origin.departureAt,
          issue: 'Origin stop has no departure time',
          action: 'Set a departure time on this stop',
        });
        continue;
      }

      for (let j = i + 1; j < stops.length; j++) {
        const destination = stops[j];
        const field = `fares[${travelClassId}:${origin.stationId}->${destination.stationId}]`;

        const amount = resolveFareAmount(
          fares,
          travelClassId,
          origin.stationId,
          destination.stationId,
          origin.departureAt,
        );

        if (amount === null) {
          details.push({
            field,
            rejectedValue: null,
            issue: `missing or invalid fare for class ${travelClassId} from ${origin.stationId} to ${destination.stationId}`,
            action: 'Add a positive fare for this class and station pair',
          });
          continue;
        }

        amounts.set(`${i}|${j}`, amount);

        if (!cheapest || amount < cheapest.amount) {
          cheapest = { field, amount };
        }
      }
    }

    for (let i = 0; i < stops.length - 1; i++) {
      for (let j = i + 1; j < stops.length; j++) {
        const amount = amounts.get(`${i}|${j}`);
        if (amount === undefined) continue;

        for (const contained of [`${i}|${j - 1}`, `${i + 1}|${j}`]) {
          const inner = amounts.get(contained);

          if (inner !== undefined && amount < inner) {
            details.push({
              field: `fares[${travelClassId}:${stops[i].stationId}->${stops[j].stationId}]`,
              rejectedValue: amount,
              issue: `fare for class ${travelClassId} from stop ${i} to ${j} (${amount}) is less than the segment it contains (${inner})`,
              action: 'Raise this fare so it is not cheaper than a segment it contains',
            });
          }
        }
      }
    }

    // The fee is strictly positive, so `fare >= floor` already implies
    // `fare + fee >= floor` -- no fee term belongs in this comparison.
    if (cheapest && !isChargeableFare(cheapest.amount)) {
      details.push({
        field: cheapest.field,
        rejectedValue: cheapest.amount,
        issue: `is below the minimum chargeable amount (${cheapest.amount} piastres)`,
        action: 'Raise this fare to at least the Stripe minimum',
      });
    }
  }

  return details;
}

/** Every seat of every coach, counted once. No validation -- just the sum. */
export function computeCapacity(coaches: TrainCoachEntity[]): number {
  let capacity = 0;

  for (const coach of coaches) {
    for (const row of coach.coachLayout.rows) {
      capacity += row.leftSeats.length + row.rightSeats.length;
    }
  }

  return capacity;
}

/**
 * A coach must name a real layout, and a layout must not repeat a seat
 * number -- a repeat would inflate capacity and, from Sprint 3, would make
 * inventory create two seats with the same label.
 */
export function validateCapacityIssues(
  coaches: TrainCoachEntity[],
  knownCoachLayoutIds: ReadonlySet<string>,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (let i = 0; i < coaches.length; i++) {
    const coach = coaches[i];

    if (!knownCoachLayoutIds.has(coach.coachLayout.id)) {
      details.push({
        field: `coaches[${i}].coachLayoutId`,
        rejectedValue: coach.coachLayout.id,
        issue: 'is not a known coach layout',
        action: 'Choose a coach layout from the layout list',
      });
    }

    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const row of coach.coachLayout.rows) {
      for (const seat of [...row.leftSeats, ...row.rightSeats]) {
        if (seen.has(seat)) duplicates.add(seat);
        seen.add(seat);
      }
    }

    if (duplicates.size > 0) {
      details.push({
        field: `coaches[${i}].coachLayout.rows`,
        rejectedValue: [...duplicates].sort(),
        issue: `Coach ${coach.coachNumber} repeats seat ${[...duplicates]
          .sort()
          .join(', ')}`,
        action: 'Remove the repeated seat number from the layout',
      });
    }
  }

  if (computeCapacity(coaches) === 0) {
    details.push({
      field: 'coaches',
      rejectedValue: coaches.length,
      issue: 'Train has no seats',
      action: 'Add at least one coach with seats',
    });
  }

  return details;
}
