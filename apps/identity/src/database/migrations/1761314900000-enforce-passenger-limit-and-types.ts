import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EnforcePassengerLimitAndTypes1761314900000 implements MigrationInterface {
  name = 'EnforcePassengerLimitAndTypes1761314900000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION check_passenger_limit_trigger()
      RETURNS TRIGGER AS $$
      DECLARE
        companion_count INTEGER;
      BEGIN
        IF NEW.is_self = false THEN
          SELECT COUNT(*) INTO companion_count
          FROM passenger
          WHERE account_id = NEW.account_id AND is_self = false AND id != NEW.id;

          IF companion_count >= 10 THEN
            RAISE EXCEPTION 'PASSENGER_LIMIT_REACHED'
              USING ERRCODE = 'check_violation',
                    MESSAGE = 'Account companion passenger limit of 10 reached';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_passenger_limit
      BEFORE INSERT OR UPDATE ON passenger
      FOR EACH ROW
      EXECUTE FUNCTION check_passenger_limit_trigger();
    `);

    await queryRunner.query(`
      UPDATE profile_type
      SET name_ar = 'كوامل'
      WHERE code = 'Regular';
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_passenger_limit ON passenger;
    `);

    await queryRunner.query(`
      DROP FUNCTION IF EXISTS check_passenger_limit_trigger();
    `);

    await queryRunner.query(`
      UPDATE profile_type
      SET name_ar = 'عادي'
      WHERE code = 'Regular';
    `);
  }
}
