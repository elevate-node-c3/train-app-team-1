import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task 6's version guard compares this column atomically against each
 * publication's version; default 0 keeps existing raw-SQL fixtures valid.
 */
export class AddTripTimetableVersion1794600000005 implements MigrationInterface {
  name = 'AddTripTimetableVersion1794600000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_trip"
        ADD COLUMN "timetable_version" integer NOT NULL DEFAULT 0
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "inventory_trip" DROP COLUMN "timetable_version"`);
  }
}
