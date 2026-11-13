import { DataSource } from 'typeorm';

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
} as const;

/**
 * One on-sale trip, six stops at positions 0-5, two coaches of different
 * travel classes, ten seats each (seats 1-10 per coach, alternating sides).
 */
export async function seedSixStopTrip(source: DataSource): Promise<void> {
  const f = SIX_STOP_TRIP;

  await source.query(`INSERT INTO inventory_trip (id, status) VALUES ($1, 'on_sale')`, [
    f.tripId,
  ]);

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
