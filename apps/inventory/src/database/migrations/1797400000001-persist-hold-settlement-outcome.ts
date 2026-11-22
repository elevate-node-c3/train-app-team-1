import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PersistHoldSettlementOutcome1797400000001 implements MigrationInterface {
  name = 'PersistHoldSettlementOutcome1797400000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "seat_hold_group" ADD COLUMN "settlement_outcome" text
    `);
    // Earlier sales retained ownership but not whether seats were reallocated.
    await queryRunner.query(`
      UPDATE "seat_hold_group" SET "settlement_outcome" = 'SOLD'
      WHERE "state" = 'sold'
    `);
    await queryRunner.query(`
      ALTER TABLE "seat_hold_group"
        ADD CONSTRAINT "chk_seat_hold_group_settlement_outcome"
          CHECK ("settlement_outcome" IN ('SOLD', 'REALLOCATED', 'NO_SEATS')),
        ADD CONSTRAINT "chk_seat_hold_group_settlement_state"
          CHECK (("state" = 'sold') = COALESCE(
            "settlement_outcome" IN ('SOLD', 'REALLOCATED'), false
          ))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [usage]: { hasSettlements: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM "seat_hold_group" WHERE "settlement_outcome" IS NOT NULL
      ) AS "hasSettlements"
    `);
    if (usage?.hasSettlements !== false) {
      throw new Error(
        'Cannot remove durable settlement decisions while settled holds exist. Use a forward migration that preserves sales and refusals.',
      );
    }
    await queryRunner.query(`
      ALTER TABLE "seat_hold_group"
        DROP CONSTRAINT "chk_seat_hold_group_settlement_state",
        DROP CONSTRAINT "chk_seat_hold_group_settlement_outcome",
        DROP COLUMN "settlement_outcome"
    `);
  }
}
