import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
  TICKET_CANCELLED_EVENT_TYPE,
  TICKET_CANCELLED_VERSION,
  type TicketCancelledEvent,
} from '@app/contracts';

import { SIX_STOP_TRIP } from './inventory-fixture.js';

export const RELEASE_COACH_NUMBER = 1;
export const RELEASE_SEAT_NUMBER = '4';

/** One sold occupation, with the hold receipt rows the release join needs. */
export async function seedSoldSeat(
  source: DataSource,
  props: {
    bookingReference: string;
    passengerRef: string;
    from: number;
    to: number;
    seatNumber?: string;
    coachNumber?: number;
  },
): Promise<{ occupationId: string; tripSeatId: string }> {
  const f = SIX_STOP_TRIP;
  const coachNumber = props.coachNumber ?? RELEASE_COACH_NUMBER;
  const seatNumber = props.seatNumber ?? RELEASE_SEAT_NUMBER;
  const coachIndex = coachNumber - 1;
  const seatIndex = Number(seatNumber) - 1;
  const seatId = f.seatIds[coachIndex * 10 + seatIndex];
  const travelClassId = f.travelClassIds[coachIndex];
  const holdId = randomUUID();
  const occupationId = randomUUID();
  const now = new Date();
  const segment = `[${props.from},${props.to})`;

  await source.query(
    `INSERT INTO seat_hold_group
       (id, booking_key, owner_id, request_fingerprint, state,
        settlement_outcome, version, extension_used, expires_at,
        released_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'sold', 'SOLD', 1, false, NULL, NULL, $5, $5)`,
    [holdId, props.bookingReference, randomUUID(), `fp:${holdId}`, now],
  );

  await source.query(
    `INSERT INTO seat_hold_assignment
       (id, hold_id, passenger_ref, passenger_key_version, trip_id,
        trip_seat_id, travel_class_id, coach_number, seat_number, row_number,
        label, outcome, origin_station_id, destination_station_id,
        origin_position, destination_position, segment, created_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, 2, NULL, 'SAME_COACH',
             $9, $10, $11, $12, $13::int4range, $14)`,
    [
      randomUUID(),
      holdId,
      props.passengerRef,
      f.tripId,
      seatId,
      travelClassId,
      coachNumber,
      seatNumber,
      f.stationIds[props.from],
      f.stationIds[props.to],
      props.from,
      props.to,
      segment,
      now,
    ],
  );

  await source.query(
    `INSERT INTO seat_occupation
       (id, trip_seat_id, trip_id, segment, state, hold_expires_at,
        released_at, reference_id, hold_id, owner_id, passenger_ref,
        passenger_token, passenger_key_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4::int4range, 'sold', NULL, NULL, $5, $5,
             $6, $7, NULL, 1, $8, $8)`,
    [
      occupationId,
      seatId,
      f.tripId,
      segment,
      holdId,
      randomUUID(),
      props.passengerRef,
      now,
    ],
  );

  return { occupationId, tripSeatId: seatId };
}

export async function occupationState(
  source: DataSource,
  occupationId: string,
): Promise<{ state: string; releasedAt: Date | null }> {
  const [row] = await source.query(
    `SELECT state, released_at AS "releasedAt" FROM seat_occupation WHERE id = $1`,
    [occupationId],
  );
  return row as { state: string; releasedAt: Date | null };
}

export function ticketCancelled(props: {
  bookingReference: string;
  passengerRef: string;
  refundPiastres?: number;
}): TicketCancelledEvent {
  return {
    id: randomUUID(),
    type: TICKET_CANCELLED_EVENT_TYPE,
    version: TICKET_CANCELLED_VERSION,
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-release-1',
    producer: 'booking',
    payload: {
      ticketId: randomUUID(),
      bookingReference: props.bookingReference,
      passengerRef: props.passengerRef,
      tripId: SIX_STOP_TRIP.tripId,
      coachNumber: RELEASE_COACH_NUMBER,
      seatNumber: RELEASE_SEAT_NUMBER,
      accountId: randomUUID(),
      refundPiastres: props.refundPiastres ?? 7750,
      paymentReference: randomUUID(),
    },
  };
}
