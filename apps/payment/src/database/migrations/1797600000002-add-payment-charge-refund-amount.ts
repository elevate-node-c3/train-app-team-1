import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentChargeRefundAmount1797600000002
  implements MigrationInterface
{
  name = 'AddPaymentChargeRefundAmount1797600000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE payment_charge
        ADD COLUMN refund_amount_piastres integer;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE payment_charge
        DROP COLUMN refund_amount_piastres;
    `);
  }
}
