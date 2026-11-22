import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingSagaRecovery1797400000001 implements MigrationInterface {
  name = 'BookingSagaRecovery1797400000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE booking_draft
      ADD COLUMN payment_client_secret text,
      ADD COLUMN saga_attempts integer NOT NULL DEFAULT 0`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE booking_draft
      DROP COLUMN saga_attempts, DROP COLUMN payment_client_secret`);
  }
}
