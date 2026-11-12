import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two published timetable versions of one train may never overlap a day.
 * `effective_until` is the last day of the version, hence `'[]'`. Only
 * published rows are constrained; withdrawn history may overlap.
 * `EXCLUDE` needs `btree_gist` for uuid equality.
 */
export class AddTimetableVersionConstraints1793300000006
  implements MigrationInterface
{
  name = 'AddTimetableVersionConstraints1793300000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await queryRunner.query(`
      ALTER TABLE "timetable"
        ADD CONSTRAINT "excl_timetable_published_overlap"
        EXCLUDE USING gist (
          "train_id" WITH =,
          daterange("effective_from", "effective_until", '[]') WITH &&
        )
        WHERE ("status" = 'published')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timetable"
        DROP CONSTRAINT "excl_timetable_published_overlap"
    `);

    // `up` created btree_gist and nothing else uses it.
    await queryRunner.query('DROP EXTENSION IF EXISTS btree_gist');
  }
}
