import type { MigrationInterface, QueryRunner } from 'typeorm';

/** TA-109: cancellation frees a sold seat, so occupation needs its own terminal state. */
export class AddInventorySeatOccupationReleasedState1797600000003
  implements MigrationInterface
{
  name = 'AddInventorySeatOccupationReleasedState1797600000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        DROP CONSTRAINT "chk_seat_occupation_state"
    `);
    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        ADD CONSTRAINT "chk_seat_occupation_state"
          CHECK ("state" IN ('held', 'sold', 'released'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Keep released rows fenced by released_at; the old CHECK cannot name them.
    await queryRunner.query(`
      UPDATE "seat_occupation" SET "state" = 'sold' WHERE "state" = 'released'
    `);
    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        DROP CONSTRAINT "chk_seat_occupation_state"
    `);
    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        ADD CONSTRAINT "chk_seat_occupation_state"
          CHECK ("state" IN ('held', 'sold'))
    `);
  }
}
