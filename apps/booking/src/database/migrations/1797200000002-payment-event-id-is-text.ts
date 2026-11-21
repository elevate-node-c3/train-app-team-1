import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payment's event id is a Stripe-event-derived identifier recorded by the
 * webhook path, not necessarily a UUID — Task 8's migration mistakenly typed
 * the column `uuid`. Corrected forward rather than editing an already-applied
 * migration.
 */
export class PaymentEventIdIsText1797200000002
  implements MigrationInterface
{
  name = 'PaymentEventIdIsText1797200000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE booking_draft
        ALTER COLUMN payment_event_id TYPE text USING payment_event_id::text
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE booking_draft
        ALTER COLUMN payment_event_id TYPE uuid USING payment_event_id::uuid
    `);
  }
}
