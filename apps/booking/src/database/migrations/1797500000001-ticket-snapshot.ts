import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TA-108: what a ticket prints, copied once at issuance, and the ticket's own
 * state.
 *
 * - `snapshot` is the printed ticket (passenger, train, plain-word class, the
 *   passenger's own stations and Cairo times, fare). It is never rebuilt from
 *   the live passenger or timetable, so a rename or a republished timetable
 *   cannot reach an issued ticket.
 * - `departs_at`/`arrives_at` are the snapshot's instants as real columns: the
 *   lists sort on the first and a share link expires at the second.
 * - `qr_payload` is signed once at issuance and printed verbatim.
 * - `status` belongs to cancellation (BOOK-4) and voiding; this migration only
 *   gives them somewhere to write it.
 *
 * Every new column is nullable: tickets TA-107 issued before this one carry no
 * snapshot, and the lists and documents skip them rather than invent one.
 *
 * `booking_code` is the short reference a traveller reads aloud; the booking's
 * id stays the reference every API and event already names.
 */
export class TicketSnapshot1797500000001 implements MigrationInterface {
  name = 'TicketSnapshot1797500000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ticket
        ADD COLUMN owner_id varchar,
        ADD COLUMN snapshot jsonb,
        ADD COLUMN departs_at timestamptz,
        ADD COLUMN arrives_at timestamptz,
        ADD COLUMN qr_payload text,
        ADD COLUMN status varchar(16) NOT NULL DEFAULT 'active',
        ADD COLUMN status_reason text,
        ADD COLUMN status_changed_at timestamptz,
        ADD CONSTRAINT chk_ticket_status
          CHECK (status IN ('active', 'cancelled', 'voided'))
    `);

    // A traveller's list: their tickets, in departure order.
    await queryRunner.query(`
      CREATE INDEX idx_ticket_owner_departs
        ON ticket (owner_id, departs_at, id)
        WHERE snapshot IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE booking_draft ADD COLUMN booking_code varchar(8)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_booking_draft_booking_code
        ON booking_draft (booking_code)
        WHERE booking_code IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX uq_booking_draft_booking_code');
    await queryRunner.query(
      'ALTER TABLE booking_draft DROP COLUMN booking_code',
    );
    await queryRunner.query('DROP INDEX idx_ticket_owner_departs');
    await queryRunner.query(`
      ALTER TABLE ticket
        DROP CONSTRAINT chk_ticket_status,
        DROP COLUMN status_changed_at,
        DROP COLUMN status_reason,
        DROP COLUMN status,
        DROP COLUMN qr_payload,
        DROP COLUMN arrives_at,
        DROP COLUMN departs_at,
        DROP COLUMN snapshot,
        DROP COLUMN owner_id
    `);
  }
}
