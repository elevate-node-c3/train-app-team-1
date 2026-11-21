import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BR-36 settlement needs a terminal "sold" head: a hold that converted into a
 * real sale is neither held, released, expired, nor cancelled.
 */
export class AddHoldStateSold1797100000001 implements MigrationInterface {
  name = 'AddHoldStateSold1797100000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "seat_hold_group"
        DROP CONSTRAINT "chk_seat_hold_group_state"
    `);
    await queryRunner.query(`
      ALTER TABLE "seat_hold_group"
        ADD CONSTRAINT "chk_seat_hold_group_state"
          CHECK ("state" IN ('held', 'released', 'expired', 'cancelled', 'sold'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "seat_hold_group"
        DROP CONSTRAINT "chk_seat_hold_group_state"
    `);
    await queryRunner.query(`
      ALTER TABLE "seat_hold_group"
        ADD CONSTRAINT "chk_seat_hold_group_state"
          CHECK ("state" IN ('held', 'released', 'expired', 'cancelled'))
    `);
  }
}
