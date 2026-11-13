import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Design doc section 7 stores seat_number as text and keeps coach position,
 * class names and seat adjacency. The earlier tables compressed those columns
 * out. Backfill defaults let existing rows survive; they are dropped
 * immediately so every future writer must supply the real values.
 *
 * Postgres resolves every subcommand of one ALTER TABLE against the table's
 * original shape, so a column cannot be added and have its default dropped in
 * the same statement. Each change below is therefore its own statement.
 */
export class AlignTripSchemaWithDesign1794600000007 implements MigrationInterface {
  name = 'AlignTripSchemaWithDesign1794600000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_coach"
        ADD COLUMN "position" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_coach"
        ADD COLUMN "travel_class_name_en" text NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_coach"
        ADD COLUMN "travel_class_name_ar" text NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_coach"
        ALTER COLUMN "position" DROP DEFAULT,
        ALTER COLUMN "travel_class_name_en" DROP DEFAULT,
        ALTER COLUMN "travel_class_name_ar" DROP DEFAULT
    `);

    await queryRunner.query(`
      ALTER TABLE "trip_seat"
        ALTER COLUMN "seat_number" TYPE text USING "seat_number"::text
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_seat"
        ADD COLUMN "row_number" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_seat"
        ADD COLUMN "seat_index_in_side" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_seat"
        ALTER COLUMN "row_number" DROP DEFAULT,
        ALTER COLUMN "seat_index_in_side" DROP DEFAULT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting seat_number fails if any text label is not numeric, which is
    // the point of the column: labels such as 1A are valid and irreversible.
    await queryRunner.query(`
      ALTER TABLE "trip_seat"
        DROP COLUMN "seat_index_in_side",
        DROP COLUMN "row_number",
        ALTER COLUMN "seat_number" TYPE integer USING "seat_number"::integer
    `);

    await queryRunner.query(`
      ALTER TABLE "trip_coach"
        DROP COLUMN "travel_class_name_ar",
        DROP COLUMN "travel_class_name_en",
        DROP COLUMN "position"
    `);
  }
}
