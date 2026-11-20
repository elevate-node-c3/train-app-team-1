import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateHoldPassengerTripKeys1794764000000 implements MigrationInterface {
  name = 'CreateHoldPassengerTripKeys1794764000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE hold_passenger_trip_key (
        trip_id uuid PRIMARY KEY,
        key_version integer NOT NULL CHECK (key_version > 0),
        key_fingerprint text NOT NULL
          CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
        pinned_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION reject_hold_passenger_trip_key_change()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'HOLD_PASSENGER_TRIP_KEY_IMMUTABLE'
          USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_hold_passenger_trip_key_immutable
      BEFORE UPDATE OR DELETE ON hold_passenger_trip_key
      FOR EACH ROW EXECUTE FUNCTION reject_hold_passenger_trip_key_change()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [usage]: { hasPinnedTrips: boolean }[] = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM hold_passenger_trip_key) AS "hasPinnedTrips"`,
    );
    if (usage?.hasPinnedTrips !== false) {
      throw new Error(
        'Cannot roll back passenger-token key pins while pinned trips exist. Existing tokens depend on their immutable key versions; retain the pins and use a forward migration.',
      );
    }
    await queryRunner.query('DROP TABLE hold_passenger_trip_key');
    await queryRunner.query(
      'DROP FUNCTION reject_hold_passenger_trip_key_change()',
    );
  }
}
