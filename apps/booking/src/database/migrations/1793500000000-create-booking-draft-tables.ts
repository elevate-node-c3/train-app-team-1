import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookingDraftTables1793500000000 implements MigrationInterface {
  name = 'CreateBookingDraftTables1793500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE booking_draft (
        id uuid PRIMARY KEY,
        user_id varchar NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED')),
        expires_at timestamptz NOT NULL,
        legs jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_booking_draft_user
        ON booking_draft (user_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_booking_draft_user`);
    await queryRunner.query(`DROP TABLE IF EXISTS booking_draft`);
  }
}
