import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task 3's inventory_trip carried only id and status. Task 6's version guard
 * needs timetable_version; the design doc's §7 trip row also needs train_id,
 * train_number, service_date, created_at and updated_at, which Task 9's
 * TripSeatsCreated event reads back from this row rather than the inbound
 * message. timetable_version defaults to 0 so existing raw-SQL fixtures that
 * only set id/status stay valid; the other identity columns have no sensible
 * default and must be supplied by every future writer.
 */
export class AddTripTimetableVersion1794600000005 implements MigrationInterface {
  name = 'AddTripTimetableVersion1794600000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_trip"
        ADD COLUMN "timetable_version" integer NOT NULL DEFAULT 0,
        ADD COLUMN "train_id" uuid NOT NULL,
        ADD COLUMN "train_number" integer NOT NULL,
        ADD COLUMN "service_date" date NOT NULL,
        ADD COLUMN "created_at" timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_trip"
        DROP COLUMN "timetable_version",
        DROP COLUMN "train_id",
        DROP COLUMN "train_number",
        DROP COLUMN "service_date",
        DROP COLUMN "created_at",
        DROP COLUMN "updated_at"
    `);
  }
}
