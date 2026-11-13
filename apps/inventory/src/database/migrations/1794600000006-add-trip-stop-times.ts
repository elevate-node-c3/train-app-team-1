import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Design doc §trip_stop requires arrival_at/departure_at; Task 3's migration
 * dropped them. Stored only — a terminus has no departure and an origin no
 * arrival, and nothing in TA-68 may read these back to decide overlap
 * (stop order and nothing else). Without them, hold/booking after TA-68
 * would need a migration plus a replay of every publication to recover times.
 */
export class AddTripStopTimes1794600000006 implements MigrationInterface {
  name = 'AddTripStopTimes1794600000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_stop"
        ADD COLUMN "arrival_at" timestamptz NULL,
        ADD COLUMN "departure_at" timestamptz NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_stop"
        DROP COLUMN "arrival_at",
        DROP COLUMN "departure_at"
    `);
  }
}
