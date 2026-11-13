import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTravellerProfile1761314800000 implements MigrationInterface {
  name = 'CreateTravellerProfile1761314800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE traveller_profile (
        account_id uuid PRIMARY KEY,
        full_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE traveller_profile');
  }
}

