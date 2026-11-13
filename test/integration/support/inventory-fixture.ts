import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { toInt4Range } from '../../../apps/inventory/src/modules/seats/segment.js';
import type { Segment } from '../../../apps/inventory/src/modules/seats/segment.js';

/**
 * Cairo -> Alexandria, six stops. Fixed literal ids so later tasks (5-10) can
 * reference them directly instead of re-deriving them from a seed call.
 */
export const SIX_STOP_TRIP = {
  tripId: '10000000-0000-0000-0000-000000000001',
  // Ramsis(0), Banha(1), Tanta(2), Damnhour(3), Sidi Gaber(4), ElRaml(5).
  stationIds: [
    '20000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000004',
    '20000000-0000-0000-0000-000000000005',
  ],
  coachIds: [
    '30000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
  ],
  // Ten seat ids per coach, coach 1 then coach 2.
  seatIds: [
    '40000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000003',
    '40000000-0000-0000-0000-000000000004',
    '40000000-0000-0000-0000-000000000005',
    '40000000-0000-0000-0000-000000000006',
    '40000000-0000-0000-0000-000000000007',
    '40000000-0000-0000-0000-000000000008',
    '40000000-0000-0000-0000-000000000009',
    '40000000-0000-0000-0000-000000000010',
    '40000000-0000-0000-0000-000000000011',
    '40000000-0000-0000-0000-000000000012',
    '40000000-0000-0000-0000-000000000013',
    '40000000-0000-0000-0000-000000000014',
    '40000000-0000-0000-0000-000000000015',
    '40000000-0000-0000-0000-000000000016',
    '40000000-0000-0000-0000-000000000017',
    '40000000-0000-0000-0000-000000000018',
    '40000000-0000-0000-0000-000000000019',
    '40000000-0000-0000-0000-000000000020',
  ],
  travelClassIds: [
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
  ],
  trainId: '60000000-0000-0000-0000-000000000001',
  trainNumber: 123,
  serviceDate: '2026-11-20',
} as const;

/**
 * One on-sale trip, six stops at positions 0-5, two coaches of different
 * travel classes, ten seats each (seats 1-10 per coach, alternating sides).
 */
export async function seedSixStopTrip(source: DataSource): Promise<void> {
  const f = SIX_STOP_TRIP;

  await source.query(
    `INSERT INTO inventory_trip (id, status, timetable_version, train_id, train_number, service_date)
     VALUES ($1, 'on_sale', 1, $2, $3, $4)`,
    [f.tripId, f.trainId, f.trainNumber, f.serviceDate],
  );

  for (const [position, stationId] of f.stationIds.entries()) {
    await source.query(
      `INSERT INTO trip_stop (trip_id, position, station_id) VALUES ($1, $2, $3)`,
      [f.tripId, position, stationId],
    );
  }

  for (const [coachIndex, coachId] of f.coachIds.entries()) {
    await source.query(
      `INSERT INTO trip_coach (id, trip_id, coach_number, travel_class_id) VALUES ($1, $2, $3, $4)`,
      [coachId, f.tripId, coachIndex + 1, f.travelClassIds[coachIndex]],
    );

    for (let seatNumber = 1; seatNumber <= 10; seatNumber += 1) {
      const seatId = f.seatIds[coachIndex * 10 + (seatNumber - 1)];
      const side = seatNumber % 2 === 0 ? 'right' : 'left';

      await source.query(
        `INSERT INTO trip_seat (id, trip_id, trip_coach_id, seat_number, travel_class_id, side)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [seatId, f.tripId, coachId, seatNumber, f.travelClassIds[coachIndex], side],
      );
    }
  }
}

/**
 * Raw SQL only — these back the seat-occupation constraint tests, which must
 * bypass the application to prove Postgres, not a repository, refuses overlap.
 *
 * Overloaded so a 'held' occupation cannot be written without an explicit
 * holdExpiresAt: chk_seat_occupation_hold_expiry only demands non-null, so a
 * silent default would satisfy the database while hiding a caller mistake —
 * Task 7's tests depend on choosing a future or past expiry on purpose.
 */
export function occupy(
  source: DataSource,
  tripSeatId: string,
  tripId: string,
  segment: Segment,
  state: 'sold',
): Promise<string>;
export function occupy(
  source: DataSource,
  tripSeatId: string,
  tripId: string,
  segment: Segment,
  state: 'held',
  holdExpiresAt: Date,
): Promise<string>;
export async function occupy(
  source: DataSource,
  tripSeatId: string,
  tripId: string,
  segment: Segment,
  state: 'held' | 'sold',
  holdExpiresAt?: Date,
): Promise<string> {
  const id = randomUUID();

  await source.query(
    `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
     VALUES ($1, $2, $3, $4::int4range, $5, $6)`,
    [id, tripSeatId, tripId, toInt4Range(segment), state, state === 'held' ? holdExpiresAt : null],
  );

  return id;
}

export async function release(source: DataSource, id: string): Promise<void> {
  await source.query(`UPDATE seat_occupation SET released_at = now() WHERE id = $1`, [id]);
}
