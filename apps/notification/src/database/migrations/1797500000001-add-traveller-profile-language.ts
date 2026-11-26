import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TA-108's confirmation email is written in the account's own language, not
 * the language of whatever request happened to confirm the booking.
 * `verification-code.issued` carries that stored language every time a code
 * is issued, including when a pending account signs up again in another one.
 */
export class AddTravellerProfileLanguage1797500000001 implements MigrationInterface {
  name = 'AddTravellerProfileLanguage1797500000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE traveller_profile
        ADD COLUMN language text
          CONSTRAINT chk_traveller_profile_language
          CHECK (language IS NULL OR language IN ('ar', 'en'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE traveller_profile DROP COLUMN language',
    );
  }
}
