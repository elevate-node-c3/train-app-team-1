import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TA-109: refund bookkeeping and a per-cancellation idempotency key. The key
 * is unique only when present, so a replayed cancellation cannot refund twice.
 * Every column is nullable: tickets issued before this one have no refund.
 */
export class TicketCancellation1797600000001 implements MigrationInterface {
  name = 'TicketCancellation1797600000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ticket
        ADD COLUMN refund_status varchar(16) NULL,
        ADD COLUMN refund_piastres integer NULL,
        ADD COLUMN cancellation_idempotency_key text NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX ticket_cancellation_idempotency_key_idx
        ON ticket (cancellation_idempotency_key)
        WHERE cancellation_idempotency_key IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX ticket_cancellation_idempotency_key_idx',
    );
    await queryRunner.query(`
      ALTER TABLE ticket
        DROP COLUMN cancellation_idempotency_key,
        DROP COLUMN refund_piastres,
        DROP COLUMN refund_status
    `);
  }
}
