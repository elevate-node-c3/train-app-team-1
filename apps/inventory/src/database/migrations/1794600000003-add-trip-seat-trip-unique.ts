import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives seat_occupation's composite FK a target, so an occupation can't claim
 * a seat from a different trip than the one it declares — same discipline as
 * trip_coach's (trip_id, id) unique for trip_seat.
 */
export class AddTripSeatTripUnique1794600000003 implements MigrationInterface {
  name = 'AddTripSeatTripUnique1794600000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_seat"
        ADD CONSTRAINT "uq_trip_seat_trip_id"
        UNIQUE ("trip_id", "id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_seat"
        DROP CONSTRAINT "uq_trip_seat_trip_id"
    `);
  }
}
