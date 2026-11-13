import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStationAuditTimestamps1794525266218 implements MigrationInterface {
  name = 'AddStationAuditTimestamps1794525266218';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['governorate', 'city', 'station']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['station', 'city', 'governorate']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        DROP COLUMN IF EXISTS "updated_at",
        DROP COLUMN IF EXISTS "created_at"
      `);
    }
  }
}
