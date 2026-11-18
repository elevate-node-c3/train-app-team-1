import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentCharges1795000000001 implements MigrationInterface {
  name = 'CreatePaymentCharges1795000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE payment_charge (
        id uuid PRIMARY KEY,
        booking_reference uuid NOT NULL UNIQUE,
        idempotency_key text NOT NULL UNIQUE,
        amount_piastres integer NOT NULL CHECK (amount_piastres > 0),
        currency varchar(16) NOT NULL CHECK (currency = 'EGP'),
        status varchar(16) NOT NULL
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE payment_charge');
  }
}
