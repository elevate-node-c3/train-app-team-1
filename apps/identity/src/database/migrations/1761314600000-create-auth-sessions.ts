import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Credentials, sessions, refresh rotation, durable counters and lockouts.
 *
 * Every invariant that prevents a double rotation, a reset replay or a counter
 * reset on a Redis restart lives here: an `if` in a use-case cannot survive two
 * processes, a partial unique index can.
 */
export class CreateAuthSessions1761314600000 implements MigrationInterface {
  name = 'CreateAuthSessions1761314600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE account
        ADD COLUMN password_hash text,
        ADD COLUMN password_updated_at timestamptz,
        ADD COLUMN email_verified_at timestamptz,
        ADD COLUMN bookable boolean NOT NULL DEFAULT false,
        ADD COLUMN roles text[] NOT NULL DEFAULT ARRAY[]::text[]
    `);

    await queryRunner.query(`
      ALTER TABLE verification_code
        ADD COLUMN attempts integer NOT NULL DEFAULT 0
          CHECK (attempts >= 0),
        ADD COLUMN max_attempts integer NOT NULL DEFAULT 5
          CHECK (max_attempts > 0)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_verification_code_live_purpose
        ON verification_code (account_id, purpose, expires_at DESC)
        WHERE consumed_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE verification_code_request (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        account_id uuid REFERENCES account (id) ON DELETE SET NULL,
        purpose text NOT NULL
          CHECK (purpose IN ('sign_up', 'password_reset')),
        issued_at timestamptz NOT NULL
      )
    `);

    // Counts for addresses that do not exist too: otherwise an attacker can
    // hammer "is this address registered" without ever touching a counter.
    await queryRunner.query(`
      CREATE INDEX idx_verification_code_request_email
        ON verification_code_request (email, issued_at DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE sign_in_lockout (
        email text PRIMARY KEY,
        failed_count integer NOT NULL DEFAULT 0
          CHECK (failed_count >= 0),
        locked_until timestamptz,
        updated_at timestamptz NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE session (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL
          REFERENCES account (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL,
        last_used_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        revoked_reason text,
        reuse_detected_at timestamptz,
        CONSTRAINT session_expiry CHECK (expires_at > created_at)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_session_account
        ON session (account_id)
    `);

    await queryRunner.query(`
      CREATE TABLE refresh_token (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL
          REFERENCES session (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'rotated', 'revoked')),
        issued_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        rotated_at timestamptz,
        -- Deferred: rotation marks the old row before inserting the successor,
        -- because the active-token unique index is immediate. The reference is
        -- checked at commit, when both rows exist.
        replaced_by_id uuid REFERENCES refresh_token (id)
          DEFERRABLE INITIALLY DEFERRED,
        grace_payload text,
        grace_expires_at timestamptz,
        revoked_at timestamptz,
        CONSTRAINT refresh_token_expiry CHECK (expires_at > issued_at)
      )
    `);

    // The rotation guarantee. Two transactions may both read the old row, but
    // only one can leave an active successor; the loser sees the rotated row
    // after its lock is released.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_refresh_token_active_session
        ON refresh_token (session_id)
        WHERE status = 'active'
    `);

    await queryRunner.query(`
      CREATE INDEX idx_refresh_token_session
        ON refresh_token (session_id)
    `);

    await queryRunner.query(`
      CREATE TABLE device_credential (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL
          REFERENCES account (id) ON DELETE CASCADE,
        session_id uuid
          REFERENCES session (id) ON DELETE SET NULL,
        kind text NOT NULL
          CHECK (kind IN ('pin')),
        credential_hash text NOT NULL,
        created_at timestamptz NOT NULL,
        revoked_at timestamptz
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_device_credential_session
        ON device_credential (session_id)
        WHERE revoked_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE device_credential');
    await queryRunner.query('DROP TABLE refresh_token');
    await queryRunner.query('DROP TABLE session');
    await queryRunner.query('DROP TABLE sign_in_lockout');
    await queryRunner.query('DROP TABLE verification_code_request');
    await queryRunner.query('DROP INDEX idx_verification_code_live_purpose');
    await queryRunner.query(`
      ALTER TABLE verification_code
        DROP COLUMN max_attempts,
        DROP COLUMN attempts
    `);
    await queryRunner.query(`
      ALTER TABLE account
        DROP COLUMN roles,
        DROP COLUMN bookable,
        DROP COLUMN email_verified_at,
        DROP COLUMN password_updated_at,
        DROP COLUMN password_hash
    `);
  }
}
