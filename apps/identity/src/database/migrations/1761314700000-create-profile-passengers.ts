import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProfilePassengers1761314700000 implements MigrationInterface {
  name = 'CreateProfilePassengers1761314700000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE account
        ADD COLUMN full_name text,
        ADD COLUMN phone_number text,
        ADD COLUMN national_id text,
        ADD COLUMN profile_type text,
        ADD COLUMN nationality text,
        ADD COLUMN profile_completed_at timestamptz
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_account_phone
        ON account (phone_number)
        WHERE phone_number IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_account_national_id
        ON account (national_id)
        WHERE national_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE passenger (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL
          REFERENCES account (id) ON DELETE CASCADE,
        full_name text NOT NULL,
        national_id text NOT NULL,
        profile_type text NOT NULL,
        nationality text NOT NULL,
        is_self boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_passenger_account
        ON passenger (account_id)
    `);

    // Only one self passenger per account
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_passenger_self_account
        ON passenger (account_id)
        WHERE is_self = true
    `);

    // A passenger list never holds the same ID twice (BR-12)
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_passenger_nid_account
        ON passenger (account_id, national_id)
    `);

    // The National ID is unique across account holders (self passengers) (BR-10, BR-12)
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_passenger_self_nid
        ON passenger (national_id)
        WHERE is_self = true
    `);

    await queryRunner.query(`
      CREATE TABLE profile_type (
        code text PRIMARY KEY,
        name_ar text NOT NULL,
        name_en text NOT NULL
      )
    `);

    await queryRunner.query(`
      INSERT INTO profile_type (code, name_ar, name_en)
      VALUES ('Regular', 'عادي', 'Regular')
    `);

    await queryRunner.query(`
      CREATE TABLE nationality (
        code text PRIMARY KEY,
        name_ar text NOT NULL,
        name_en text NOT NULL
      )
    `);

    await queryRunner.query(`
      INSERT INTO nationality (code, name_ar, name_en)
      VALUES ('Egyptian', 'مصري', 'Egyptian')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE nationality');
    await queryRunner.query('DROP TABLE profile_type');
    await queryRunner.query('DROP TABLE passenger');
    await queryRunner.query(`
      ALTER TABLE account
        DROP COLUMN profile_completed_at,
        DROP COLUMN nationality,
        DROP COLUMN profile_type,
        DROP COLUMN national_id,
        DROP COLUMN phone_number,
        DROP COLUMN full_name
    `);
  }
}

