import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  encryptNationalId,
  nationalIdBlindIndex,
  validateNationalIdVaultEnvironment,
} from '../../config/national-id-vault.js';

interface NationalIdRow {
  id: string;
  nationalId: string;
}

export class EncryptNationalIds1794765000000 implements MigrationInterface {
  name = 'EncryptNationalIds1794765000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    validateNationalIdVaultEnvironment();
    await queryRunner.query(`
      DROP INDEX uq_account_national_id;
      DROP INDEX uq_passenger_nid_account;
      DROP INDEX uq_passenger_self_nid;
      ALTER TABLE account ADD COLUMN national_id_hash text;
      ALTER TABLE passenger ADD COLUMN national_id_hash text
    `);

    const accounts: NationalIdRow[] = await queryRunner.query(
      `SELECT id, national_id AS "nationalId" FROM account WHERE national_id IS NOT NULL`,
    );
    for (const row of accounts) {
      await queryRunner.query(
        `UPDATE account SET national_id = $2, national_id_hash = $3 WHERE id = $1`,
        [
          row.id,
          encryptNationalId(row.nationalId, 'account'),
          nationalIdBlindIndex(row.nationalId),
        ],
      );
    }

    const passengers: NationalIdRow[] = await queryRunner.query(
      `SELECT id, national_id AS "nationalId" FROM passenger`,
    );
    for (const row of passengers) {
      await queryRunner.query(
        `UPDATE passenger SET national_id = $2, national_id_hash = $3 WHERE id = $1`,
        [
          row.id,
          encryptNationalId(row.nationalId, 'passenger'),
          nationalIdBlindIndex(row.nationalId),
        ],
      );
    }

    await queryRunner.query(`
      ALTER TABLE passenger ALTER COLUMN national_id_hash SET NOT NULL;
      CREATE UNIQUE INDEX uq_account_national_id
        ON account (national_id_hash) WHERE national_id_hash IS NOT NULL;
      CREATE UNIQUE INDEX uq_passenger_nid_account
        ON passenger (account_id, national_id_hash);
      CREATE UNIQUE INDEX uq_passenger_self_nid
        ON passenger (national_id_hash) WHERE is_self = true
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    void queryRunner;
    throw new Error(
      'National-ID encryption is irreversible: rollback would restore plaintext National IDs and violate MT-02 privacy guarantees. Recover with a forward migration that keeps authenticated encryption and blind indexes.',
    );
  }
}
