import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TA-107's booking-outcome emails need an address to send to.
 * `account.registered` already carries it; nothing before this read it.
 */
export class AddTravellerProfileEmail1797300000001
  implements MigrationInterface
{
  name = 'AddTravellerProfileEmail1797300000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE traveller_profile
        ADD COLUMN email text,
        ALTER COLUMN full_name DROP NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE traveller_profile
        DROP COLUMN email,
        ALTER COLUMN full_name SET NOT NULL
    `);
  }
}
