import type { ValidationIssueRef } from '@app/contracts';

import type { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import type { FareIndex } from '../trips/trip-generation.types.js';
import { fareKey, resolveStopTimes } from '../trips/trip-generation.types.js';
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
 *
 * Two rules live only here, not in the groups generation's own methods call:
 * no-duplicate-station and the Stripe floor. Both are real TA-20 publish
 * rules, but neither is safe to run against an already-published timetable --
 * a loop route that generation has been running for months has no unique
 * constraint stopping a repeated station, and the floor is a live config
 * value that must not retroactively break trips a publish already accepted.
 */
export function validateTimetableCandidate(
  candidate: TimetableCandidate,
): ValidationIssueRef[] {
  const resolvedStops = resolveStopInstants(
    candidate.stops,
    candidate.effectiveFrom,
  );

  return [
    ...validateStopsStructure(candidate.stops, candidate.knownStationIds),
    ...validateNoDuplicateStations(candidate.stops),
    ...validateStopsChronology(resolvedStops),
    ...validateFareRules(candidate.coaches, resolvedStops, candidate.fares),
    ...validateFareFloor(candidate.coaches, resolvedStops, candidate.fares),
    ...validateCapacityIssues(candidate.coaches, candidate.knownCoachLayoutIds),
  ];
}

/** Same math `buildTripStops` uses, so a candidate and a generated trip agree. */
function resolveStopInstants(
  stops: TimetableStopDraftInput[],
  effectiveFrom: string,
): ResolvedStop[] {
  return stops.map((stop) => ({
    stationId: stop.stationId,
    ...resolveStopTimes(
      effectiveFrom,
      stop.dayOffset,
      stop.arrivalTime,
      stop.departureTime,
    ),
  }));
}

/**
 * No station may appear twice in a published route. Publish-only: there is
 * no DB constraint stopping an already-published loop route (same station
 * twice, e.g. a round trip back to its origin) from existing today, and
 * generation must keep producing trips for it. Composed only in
 * `validateTimetableCandidate`, never in `validateStopsStructure`, so the
 * generator can never pick this rule up by accident.
 */
export function validateNoDuplicateStations(
  stops: TimetableStopDraftInput[],
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];
  const seenAt = new Map<string, number>();

  for (let i = 0; i < stops.length; i++) {
    const stationId = stops[i].stationId;
    const firstSeenAt = seenAt.get(stationId);

    if (firstSeenAt !== undefined) {
      details.push({
        field: `stops[${i}].stationId`,
        rejectedValue: stationId,
        issueKey: 'ISSUE_STATION_REPEATED_ON_ROUTE',
        actionKey: 'ACTION_REMOVE_REPEATED_STATION',
        params: { firstStopIndex: String(firstSeenAt) },
      });
    } else {
      seenAt.set(stationId, i);
    }
  }

  return details;
}

/**
 * The route's shape: enough stops, the right ends, every id real and used
 * once, positions and day offsets that never go backwards. Nothing here
 * touches a clock reading -- that is `validateStopsChronology`'s job.
 */
export function validateStopsStructure(
  stops: TimetableStopDraftInput[],
  knownStationIds: ReadonlySet<string>,
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

  if (stops.length < 2) {
    details.push({
      field: 'stops',
      rejectedValue: stops.length,
      issueKey: 'ISSUE_ROUTE_NEEDS_TWO_STOPS',
      actionKey: 'ACTION_ADD_STOPS_TO_TWO',
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
      issueKey: 'ISSUE_FIRST_STOP_HAS_ARRIVAL',
      actionKey: 'ACTION_CLEAR_ARRIVAL_ON_FIRST_STOP',
    });
  }

  if (!firstStop.departureTime) {
    details.push({
      field: 'stops[0].departureTime',
      rejectedValue: firstStop.departureTime,
      issueKey: 'ISSUE_FIRST_STOP_LACKS_DEPARTURE',
      actionKey: 'ACTION_SET_DEPARTURE_ON_FIRST_STOP',
    });
  }

  if (!lastStop.arrivalTime) {
    details.push({
      field: `stops[${lastIndex}].arrivalTime`,
      rejectedValue: lastStop.arrivalTime,
      issueKey: 'ISSUE_LAST_STOP_LACKS_ARRIVAL',
      actionKey: 'ACTION_SET_ARRIVAL_ON_LAST_STOP',
    });
  }

  if (lastStop.departureTime !== null) {
    details.push({
      field: `stops[${lastIndex}].departureTime`,
      rejectedValue: lastStop.departureTime,
      issueKey: 'ISSUE_LAST_STOP_HAS_DEPARTURE',
      actionKey: 'ACTION_CLEAR_DEPARTURE_ON_LAST_STOP',
    });
  }

  for (let i = 1; i < lastIndex; i++) {
    const stop = stops[i];

    if (!stop.arrivalTime) {
      details.push({
        field: `stops[${i}].arrivalTime`,
        rejectedValue: stop.arrivalTime,
        issueKey: 'ISSUE_INTERMEDIATE_STOP_TIMES_INCOMPLETE',
        actionKey: 'ACTION_SET_ARRIVAL_ON_STOP',
      });
    }

    if (!stop.departureTime) {
      details.push({
        field: `stops[${i}].departureTime`,
        rejectedValue: stop.departureTime,
        issueKey: 'ISSUE_INTERMEDIATE_STOP_TIMES_INCOMPLETE',
        actionKey: 'ACTION_SET_DEPARTURE_ON_STOP',
      });
    }
  }

  for (let i = 1; i < stops.length; i++) {
    if (stops[i].position <= stops[i - 1].position) {
      details.push({
        field: `stops[${i}].position`,
        rejectedValue: stops[i].position,
        issueKey: 'ISSUE_STOP_POSITIONS_OUT_OF_ORDER',
        actionKey: 'ACTION_RENUMBER_STOP_POSITIONS',
      });
    }

    if (stops[i].dayOffset < stops[i - 1].dayOffset) {
      details.push({
        field: `stops[${i}].dayOffset`,
        rejectedValue: stops[i].dayOffset,
        issueKey: 'ISSUE_DAY_OFFSET_GOES_BACKWARDS',
        actionKey: 'ACTION_FIX_DAY_OFFSET',
      });
    }
  }

  // Station identity, last: an id that is not even real is a worse problem
  // than its position, but reporting both costs nothing. Whether a station
  // repeats is a separate, publish-only question -- see
  // `validateNoDuplicateStations`.
  for (let i = 0; i < stops.length; i++) {
    const stationId = stops[i].stationId;

    if (!knownStationIds.has(stationId)) {
      details.push({
        field: `stops[${i}].stationId`,
        rejectedValue: stationId,
        issueKey: 'ISSUE_STATION_NOT_KNOWN',
        actionKey: 'ACTION_PICK_STATION_FROM_LIST',
      });
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
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

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
        issueKey: 'ISSUE_DEPARTURE_BEFORE_ARRIVAL',
        actionKey: 'ACTION_FIX_DEPARTURE_AFTER_ARRIVAL',
      });
    }

    if (i === 0) continue;

    const previous = stops[i - 1];

    if (!previous.departureAt || !current.arrivalAt) {
      details.push({
        field: `stops[${i}].arrivalTime`,
        rejectedValue: current.arrivalAt,
        issueKey: 'ISSUE_STOP_TIMES_INVALID',
        actionKey: 'ACTION_SET_TIMES_ON_EVERY_INTERMEDIATE_STOP',
      });
      continue;
    }

    if (current.arrivalAt.getTime() < previous.departureAt.getTime()) {
      details.push({
        field: `stops[${i}].arrivalTime`,
        rejectedValue: current.arrivalAt.toISOString(),
        issueKey: 'ISSUE_STOP_TIMES_OUT_OF_ORDER',
        actionKey: 'ACTION_FIX_STOP_TIME_ORDER',
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

  if (
    !Number.isSafeInteger(price.amountPiastres) ||
    price.amountPiastres <= 0
  ) {
    return null;
  }

  return price.amountPiastres;
}

/**
 * Every in-order pair, for every class, must have one positive fare, and a
 * longer segment must never cost less than one it contains (CAT-2). The
 * Stripe floor is a separate check -- see `validateFareFloor`.
 *
 * Comparing each pair with the pair one stop shorter at either end is
 * enough for containment -- it follows by shrinking one end at a time.
 */
export function validateFareRules(
  coaches: TrainCoachEntity[],
  stops: ResolvedStop[],
  fares: FareIndex,
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

  const travelClassIds = [
    ...new Set(coaches.map((coach) => coach.travelClass.id)),
  ];

  if (travelClassIds.length === 0) {
    details.push({
      field: 'coaches',
      rejectedValue: coaches.length,
      issueKey: 'ISSUE_TRAIN_HAS_NO_TRAVEL_CLASSES',
      actionKey: 'ACTION_ADD_COACH_WITH_TRAVEL_CLASS',
    });
    return details;
  }

  if (stops.length < 2) {
    details.push({
      field: 'stops',
      rejectedValue: stops.length,
      issueKey: 'ISSUE_ROUTE_NEEDS_TWO_STOPS',
      actionKey: 'ACTION_ADD_STOPS_TO_TWO',
    });
    return details;
  }

  for (const travelClassId of travelClassIds) {
    const amounts = new Map<string, number>();

    for (let i = 0; i < stops.length - 1; i++) {
      const origin = stops[i];

      if (!origin.departureAt) {
        details.push({
          field: `stops[${i}].departureTime`,
          rejectedValue: origin.departureAt,
          issueKey: 'ISSUE_ORIGIN_STOP_LACKS_DEPARTURE',
          actionKey: 'ACTION_SET_DEPARTURE_ON_STOP',
        });
        continue;
      }

      for (let j = i + 1; j < stops.length; j++) {
        const destination = stops[j];

        const amount = resolveFareAmount(
          fares,
          travelClassId,
          origin.stationId,
          destination.stationId,
          origin.departureAt,
        );

        if (amount === null) {
          details.push({
            field: `fares[${travelClassId}:${origin.stationId}->${destination.stationId}]`,
            rejectedValue: null,
            issueKey: 'ISSUE_FARE_MISSING_FOR_PAIR',
            actionKey: 'ACTION_ADD_FARE_FOR_PAIR',
            params: {
              travelClassId,
              originStationId: origin.stationId,
              destinationStationId: destination.stationId,
            },
          });
          continue;
        }

        amounts.set(`${i}|${j}`, amount);
      }
    }

    for (let i = 0; i < stops.length - 1; i++) {
      for (let j = i + 1; j < stops.length; j++) {
        const amount = amounts.get(`${i}|${j}`);
        if (amount === undefined) continue;

        for (const [innerOriginIndex, innerDestinationIndex] of [
          [i, j - 1],
          [i + 1, j],
        ]) {
          const inner = amounts.get(
            `${innerOriginIndex}|${innerDestinationIndex}`,
          );

          if (inner !== undefined && amount < inner) {
            details.push({
              field: `fares[${travelClassId}:${stops[i].stationId}->${stops[j].stationId}]`,
              rejectedValue: amount,
              issueKey: 'ISSUE_FARE_BELOW_CONTAINED_SEGMENT_FOR_PAIR',
              actionKey: 'ACTION_RAISE_FARE_FOR_PAIR',
              params: {
                travelClassId,
                outerOriginIndex: String(i),
                outerDestinationIndex: String(j),
                innerOriginIndex: String(innerOriginIndex),
                innerDestinationIndex: String(innerDestinationIndex),
                outerFarePiastres: String(amount),
                innerFarePiastres: String(inner),
              },
            });
          }
        }
      }
    }
  }

  return details;
}

/**
 * The cheapest purchasable thing in each class must clear Stripe's floor
 * (§6.3) -- cheapest, not shortest: the question is whether the smallest
 * amount a traveller could actually be charged clears the floor, which is
 * the minimum fare in the class, not the fare spanning the fewest stops.
 * CAT-2 containment guarantees the minimum fare is also the one every other
 * fare in the class is at least as large as.
 *
 * Publish-only: the floor is a live config value (`STRIPE_MINIMUM_CHARGE_PIASTRES`),
 * and generation must not stop producing trips for an already-published
 * timetable purely because that value changed. The fee is strictly positive,
 * so `fare >= floor` already implies `fare + fee >= floor` -- no fee term
 * belongs in this comparison.
 */
export function validateFareFloor(
  coaches: TrainCoachEntity[],
  stops: ResolvedStop[],
  fares: FareIndex,
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

  const travelClassIds = [
    ...new Set(coaches.map((coach) => coach.travelClass.id)),
  ];

  if (travelClassIds.length === 0 || stops.length < 2) {
    return details;
  }

  for (const travelClassId of travelClassIds) {
    let cheapest: { field: string; amount: number } | null = null;

    for (let i = 0; i < stops.length - 1; i++) {
      const origin = stops[i];
      if (!origin.departureAt) continue;

      for (let j = i + 1; j < stops.length; j++) {
        const destination = stops[j];

        const amount = resolveFareAmount(
          fares,
          travelClassId,
          origin.stationId,
          destination.stationId,
          origin.departureAt,
        );

        if (amount === null) continue;

        if (!cheapest || amount < cheapest.amount) {
          cheapest = {
            field: `fares[${travelClassId}:${origin.stationId}->${destination.stationId}]`,
            amount,
          };
        }
      }
    }

    if (cheapest && !isChargeableFare(cheapest.amount)) {
      details.push({
        field: cheapest.field,
        rejectedValue: cheapest.amount,
        issueKey: 'ISSUE_FARE_BELOW_PAYMENT_MINIMUM',
        actionKey: 'ACTION_RAISE_FARE_TO_PAYMENT_MINIMUM',
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
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

  for (let i = 0; i < coaches.length; i++) {
    const coach = coaches[i];

    if (!knownCoachLayoutIds.has(coach.coachLayout.id)) {
      details.push({
        field: `coaches[${i}].coachLayoutId`,
        rejectedValue: coach.coachLayout.id,
        issueKey: 'ISSUE_COACH_LAYOUT_NOT_KNOWN',
        actionKey: 'ACTION_PICK_COACH_LAYOUT_FROM_LIST',
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
        issueKey: 'ISSUE_COACH_SEATS_REPEATED',
        actionKey: 'ACTION_USE_UNIQUE_COACH_SEATS',
        params: {
          coachNumber: String(coach.coachNumber),
          seatNumbers: [...duplicates].sort().join(', '),
        },
      });
    }
  }

  if (computeCapacity(coaches) === 0) {
    details.push({
      field: 'coaches',
      rejectedValue: coaches.length,
      issueKey: 'ISSUE_TRAIN_HAS_NO_SEATS',
      actionKey: 'ACTION_ADD_COACH_WITH_SEATS',
    });
  }

  return details;
}
