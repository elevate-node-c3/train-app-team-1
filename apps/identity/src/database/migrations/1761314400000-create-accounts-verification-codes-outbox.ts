import type { MigrationInterface, QueryRunner } from 'typeorm';

/** SQL handles email uniqueness and partial indexes that TypeORM sync cannot. */
export class CreateAccountsVerificationCodesOutbox1761314400000 implements MigrationInterface {
  name = 'CreateAccountsVerificationCodesOutbox1761314400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE account (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        language text NOT NULL DEFAULT 'ar'
          CHECK (language IN ('ar', 'en')),
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'disabled')),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Email uniqueness must ignore case.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_account_email_lower
        ON account (lower(email))
    `);

    await queryRunner.query(`
      CREATE TABLE verification_code (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL
          REFERENCES account (id) ON DELETE CASCADE,
        purpose text NOT NULL,
        code_hash text NOT NULL,
        code_salt text NOT NULL,
        issued_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        CONSTRAINT verification_code_expiry
          CHECK (expires_at > issued_at)
      )
    `);

    // Index only live codes, not consumed history.
    await queryRunner.query(`
      CREATE INDEX idx_verification_code_live
        ON verification_code (account_id, expires_at DESC)
        WHERE consumed_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_event (
        id uuid PRIMARY KEY,
        event_type text NOT NULL,
        event_version integer NOT NULL CHECK (event_version > 0),
        routing_key text NOT NULL,
        payload jsonb NOT NULL,
        correlation_id text NOT NULL,
        producer text NOT NULL,
        occurred_at timestamptz NOT NULL,
        published_at timestamptz,
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error text
      )
    `);

    // Match the relay poll predicate so the index contains only the backlog.
    await queryRunner.query(`
      CREATE INDEX idx_outbox_event_unpublished
        ON outbox_event (next_attempt_at, occurred_at)
        WHERE published_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query('DROP TABLE verification_code');
    await queryRunner.query('DROP TABLE account');
  }
}
