import { describe, it, expect, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { inventoryDataSource, truncateInventory } from './support/inventory-database.js';
import { SIX_STOP_TRIP, seedSixStopTrip } from './support/inventory-fixture.js';

async function insertStop(tripId: string, stationId: string, position: number): Promise<void> {
  const source = await inventoryDataSource();
  await source.query(
    `INSERT INTO trip_stop (trip_id, position, station_id) VALUES ($1, $2, $3)`,
    [tripId, position, stationId],
  );
}

async function insertCoach(
  tripId: string,
  coachId: string,
  coachNumber: number,
  travelClassId: string,
  position = 0,
  travelClassNameEn = 'Economy',
  travelClassNameAr = 'اقتصادية',
): Promise<void> {
  const source = await inventoryDataSource();
  await source.query(
    `INSERT INTO trip_coach
       (id, trip_id, coach_number, position, travel_class_id,
        travel_class_name_en, travel_class_name_ar)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      coachId,
      tripId,
      coachNumber,
      position,
      travelClassId,
      travelClassNameEn,
      travelClassNameAr,
    ],
  );
}

async function insertSeat(
  seatId: string,
  tripId: string,
  coachId: string,
  seatNumber: number,
  travelClassId: string,
  side = 'left',
  rowNumber = 1,
  seatIndexInSide = 0,
): Promise<void> {
  const source = await inventoryDataSource();
  await source.query(
    `INSERT INTO trip_seat
       (id, trip_id, trip_coach_id, seat_number, travel_class_id,
        row_number, side, seat_index_in_side)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      seatId,
      tripId,
      coachId,
      String(seatNumber),
      travelClassId,
      rowNumber,
      side,
      seatIndexInSide,
    ],
  );
}

describe('inventory migrations', () => {
  it('creates the outbox and inbox tables', async () => {
    const source = await inventoryDataSource();
    const rows: { table_name: string }[] = await source.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [['outbox_event', 'processed_event']],
    );
    expect(rows.map((r) => r.table_name)).toEqual(['outbox_event', 'processed_event']);
  });

  it('indexes only unpublished outbox rows', async () => {
    const source = await inventoryDataSource();
    const rows: { indexdef: string }[] = await source.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_outbox_event_unpublished'`,
    );
    expect(rows[0].indexdef).toContain('WHERE (published_at IS NULL)');
  });
});

describe('the trip tables', () => {
  let source: DataSource;

  beforeEach(async () => {
    source = await inventoryDataSource();
    await truncateInventory(source);
    await seedSixStopTrip(source);
  });

  it('refuses a second stop at the same station on one trip', async () => {
    // seedSixStopTrip already placed station 0; inserting it at position 6 must
    // fail on the station uniqueness constraint, not the (trip_id, position) PK.
    await expect(insertStop(SIX_STOP_TRIP.tripId, SIX_STOP_TRIP.stationIds[0], 6)).rejects.toThrow(
      /uq_trip_stop_station/,
    );
  });

  it('stores seat_number as text so alphanumeric labels can exist', async () => {
    const [column]: { data_type: string }[] = await source.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trip_seat'
         AND column_name = 'seat_number'`,
    );
    expect(column.data_type).toBe('text');
  });

  it('refuses two coaches with the same number on one trip', async () => {
    // unique (trip_id, coach_number): coach 1 already exists on this trip
    await expect(
      insertCoach(
        SIX_STOP_TRIP.tripId,
        '30000000-0000-0000-0000-000000000099',
        1,
        SIX_STOP_TRIP.travelClassIds[0],
      ),
    ).rejects.toThrow(/uq_trip_coach_number/);
  });

  it('refuses two seats with the same number in one coach', async () => {
    // unique (trip_coach_id, seat_number): seat 1 already exists in coach 1
    await expect(
      insertSeat(
        '40000000-0000-0000-0000-000000000099',
        SIX_STOP_TRIP.tripId,
        SIX_STOP_TRIP.coachIds[0],
        1,
        SIX_STOP_TRIP.travelClassIds[0],
      ),
    ).rejects.toThrow(/uq_trip_seat_number/);
  });

  it('accepts seat 1 in two different coaches', async () => {
    // uniqueness is per coach, not per trip: seat 1 exists in coach 1 and
    // coach 2 already; a third coach can still take seat number 1.
    const thirdCoachId = '30000000-0000-0000-0000-000000000003';
    await insertCoach(SIX_STOP_TRIP.tripId, thirdCoachId, 3, SIX_STOP_TRIP.travelClassIds[0]);

    await expect(
      insertSeat(
        '40000000-0000-0000-0000-000000000099',
        SIX_STOP_TRIP.tripId,
        thirdCoachId,
        1,
        SIX_STOP_TRIP.travelClassIds[0],
      ),
    ).resolves.not.toThrow();
  });

  it('refuses a seat whose trip_id disagrees with its coach\'s real trip', async () => {
    // A second, real trip so trip_id itself is valid — isolates the failure
    // to the composite FK, not a missing inventory_trip row.
    const otherTripId = '10000000-0000-0000-0000-000000000002';
    await source.query(
      `INSERT INTO inventory_trip (id, status, timetable_version, train_id, train_number, service_date)
       VALUES ($1, 'on_sale', 1, '60000000-0000-0000-0000-000000000001', 999, '2026-01-01')`,
      [otherTripId],
    );

    // Coach belongs to SIX_STOP_TRIP.tripId; claiming otherTripId must be refused.
    // seat_number 11 is unused on this coach, so uq_trip_seat_number can't fire first.
    await expect(
      insertSeat(
        '40000000-0000-0000-0000-000000000099',
        otherTripId,
        SIX_STOP_TRIP.coachIds[0],
        11,
        SIX_STOP_TRIP.travelClassIds[0],
      ),
    ).rejects.toThrow(/fk_trip_seat_coach/);
  });

  it('refuses a status outside on_sale and closed', async () => {
    // Every NOT NULL column gets a value so the status CHECK is the only
    // constraint left that can fire.
    await expect(
      source.query(
        `INSERT INTO inventory_trip (id, status, timetable_version, train_id, train_number, service_date)
         VALUES ($1, 'pending', 1, '60000000-0000-0000-0000-000000000001', 999, '2026-01-01')`,
        ['10000000-0000-0000-0000-000000000099'],
      ),
    ).rejects.toThrow(/chk_inventory_trip_status/);
  });
});
