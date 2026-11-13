import type { TripPublishedPayloadV1 } from '@app/contracts';

export type PublicationVerdict =
  | { kind: 'usable' }
  | { kind: 'incomplete'; reason: string }
  | { kind: 'malformed'; reason: string };

function incomplete(reason: string): PublicationVerdict {
  return { kind: 'incomplete', reason };
}

function malformed(reason: string): PublicationVerdict {
  return { kind: 'malformed', reason };
}

function hasDuplicates(values: Array<string | number>): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Decides whether a publication is safe to turn into a seat plan at all.
 * `incomplete` means catalog may still be generating — retry. `malformed`
 * means the data itself is broken — retrying cannot help.
 */
export function verdictFor(payload: TripPublishedPayloadV1): PublicationVerdict {
  if (payload.stops.length < 2) {
    return malformed('a trip needs at least two stops to have a segment');
  }

  if (hasDuplicates(payload.stops.map((stop) => stop.stationId))) {
    return malformed('duplicate station id among the stops');
  }

  if (payload.coaches.length === 0) {
    return incomplete('no coaches yet');
  }

  if (hasDuplicates(payload.coaches.map((coach) => coach.coachNumber))) {
    return malformed('duplicate coach number');
  }

  for (const coach of payload.coaches) {
    if (coach.coachLayout.rows.length === 0) {
      return incomplete(`coach ${coach.coachNumber} has no layout rows yet`);
    }

    const seatNumbers = coach.coachLayout.rows.flatMap((row) => [
      ...row.leftSeats,
      ...row.rightSeats,
    ]);

    if (seatNumbers.length === 0) {
      return incomplete(`coach ${coach.coachNumber}'s layout rows hold no seats yet`);
    }

    if (hasDuplicates(seatNumbers)) {
      return malformed(`duplicate seat number inside coach ${coach.coachNumber}`);
    }
  }

  return { kind: 'usable' };
}
