import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStripeCustomersAndSavedCards1796000000001
  implements MigrationInterface
{
  name = 'CreateStripeCustomersAndSavedCards1796000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE payment_customer (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL UNIQUE,
        stripe_customer_id varchar(128) NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_payment_customer_account ON payment_customer(account_id);

      CREATE TABLE saved_card (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL,
        stripe_customer_id varchar(128) NOT NULL,
        stripe_payment_method_id varchar(128) NOT NULL UNIQUE,
        brand varchar(32) NOT NULL,
        last4 varchar(4) NOT NULL,
        exp_month integer NOT NULL,
        exp_year integer NOT NULL,
        cardholder_name varchar(255) NOT NULL,
        fingerprint varchar(128) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'active',
        last_used_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX uq_saved_card_account_fingerprint ON saved_card (account_id, fingerprint) WHERE status = 'active';
      CREATE INDEX idx_saved_card_account_status ON saved_card (account_id, status);

      ALTER TABLE payment_charge
        ADD COLUMN card_brand varchar(32) NULL,
        ADD COLUMN card_last4 varchar(4) NULL,
        ADD COLUMN stripe_payment_method_id varchar(128) NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE payment_charge
        DROP COLUMN IF EXISTS stripe_payment_method_id,
        DROP COLUMN IF EXISTS card_last4,
        DROP COLUMN IF EXISTS card_brand;
      DROP TABLE IF EXISTS saved_card;
      DROP TABLE IF EXISTS payment_customer;
    `);
  }
}
