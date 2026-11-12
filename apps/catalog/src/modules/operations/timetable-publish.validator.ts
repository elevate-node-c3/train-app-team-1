import type { ValidationIssueRef } from '@app/contracts';

import type { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import type { FareIndex } from '../trips/trip-generation.types.js';
import { fareKey, resolveStopTimes } from '../trips/trip-generation.types.js';
import { isChargeableFare } from '../../config/operations-settings.js';

/** Timetable stops use HH:mm wall-clock times, not dated instants. */
export interface TimetableStopDraftInput {
  stationId: string;
  position: number;
  dayOffset: number;
  arrivalTime: string | null;
  departureTime: string | null;
}

export interface TimetableCandidate {
  stops: TimetableStopDraftInput[];
  coaches: TrainCoachEntity[];
  fares: FareIndex;
  knownStationIds: ReadonlySet<string>;
  knownCoachLayoutIds: ReadonlySet<string>;
  effectiveFrom: string;
}

interface ResolvedStop {
  stationId: string;
  arrivalAt: Date | null;
  departureAt: Date | null;
}

/**
 * Collect all candidate errors without throwing.
 * Duplicate stations and Stripe's live minimum are publish-only checks; do not
 * apply them to existing loop routes or previously accepted fares during generation.
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
 * Publish-only: reject duplicate station IDs.
 * Keep this out of validateStopsStructure so generation supports existing loop
 * routes, which have no database uniqueness constraint.
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
 * Check stop count, endpoint times, known stations, ordered positions, and
 * nondecreasing day offsets. Chronology and publish-only duplicate checks are separate.
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
 * Departures must not precede arrivals; stops must not precede previous stops.
 * Use resolved instants so publish and generation share this check.
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
 * Every forward pair in every class needs a positive fare. A segment must cost
 * at least as much as any segment it contains; checking one stop shorter at each
 * end proves containment. Stripe's minimum is checked separately.
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
 * Each class's cheapest fare, not its shortest segment, must meet Stripe's minimum.
 * Publish-only: changing STRIPE_MINIMUM_CHARGE_PIASTRES must not stop generation
 * for accepted timetables. Fees are positive, so fare >= floor already implies
 * fare + fee >= floor; do not include a fee term here.
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

/** Capacity calculation does not validate layouts. */
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
 * Require real layouts and unique seat labels to avoid inflated capacity and
 * duplicate inventory seats.
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
