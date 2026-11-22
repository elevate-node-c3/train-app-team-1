import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PaymentChargeRecovery1797400000001 implements MigrationInterface {
  name = 'PaymentChargeRecovery1797400000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE payment_charge
        ADD COLUMN intent_creation_started_at timestamptz,
        ADD COLUMN intent_creation_claim uuid,
        ADD COLUMN intent_creation_lease_until timestamptz,
        ADD COLUMN intent_creation_last_error text,
        ADD COLUMN stripe_customer_id varchar(128),
        ADD COLUMN cancellation_requested_at timestamptz;

      -- Existing unmapped rows may already have made a Stripe request. Never
      -- assume that a missing local ID proves that no remote intent exists.
      UPDATE payment_charge
         SET intent_creation_started_at = now() - interval '24 hours',
             intent_creation_last_error = 'Legacy unmapped intent requires reconciliation'
       WHERE stripe_payment_intent_id IS NULL AND status = 'started';

      CREATE UNIQUE INDEX uq_payment_charge_stripe_intent
        ON payment_charge (stripe_payment_intent_id)
        WHERE stripe_payment_intent_id IS NOT NULL;
      CREATE INDEX idx_payment_charge_recovery
        ON payment_charge (intent_creation_lease_until)
        WHERE status = 'started' AND
          (stripe_payment_intent_id IS NOT NULL OR intent_creation_started_at IS NOT NULL OR cancellation_requested_at IS NOT NULL);

      DROP INDEX uq_stripe_event_object_type;
      CREATE INDEX idx_stripe_event_pending
        ON stripe_event (received_at, id) WHERE processed_at IS NULL;
      ALTER TABLE stripe_event
        ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const pending = (await queryRunner.query(`SELECT 1 FROM payment_charge
      WHERE intent_creation_started_at IS NOT NULL OR cancellation_requested_at IS NOT NULL LIMIT 1`)) as unknown[];
    if (pending.length) {
      throw new Error(
        'Cannot remove durable payment recovery state after an intent or cancellation was attempted',
      );
    }
    await queryRunner.query(`
      ALTER TABLE stripe_event DROP COLUMN next_attempt_at;
      DROP INDEX idx_stripe_event_pending;
      -- Different failure attempts legitimately share an object/type, so a
      -- rollback must not reinstall the old lossy uniqueness constraint.
      DROP INDEX idx_payment_charge_recovery;
      DROP INDEX uq_payment_charge_stripe_intent;
      ALTER TABLE payment_charge
        DROP COLUMN cancellation_requested_at,
        DROP COLUMN stripe_customer_id,
        DROP COLUMN intent_creation_last_error,
        DROP COLUMN intent_creation_lease_until,
        DROP COLUMN intent_creation_claim,
        DROP COLUMN intent_creation_started_at;
    `);
  }
}
