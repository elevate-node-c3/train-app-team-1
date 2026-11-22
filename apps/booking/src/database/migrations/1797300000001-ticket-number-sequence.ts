import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TicketIssuerService numbered `TKT-{n}` starting at 1 on every call, so the
 * first ticket of every booking collided on the globally-unique
 * `uq_ticket_number` constraint — the second booking confirmed anywhere
 * could never issue a ticket. A database sequence makes the number globally
 * unique in fact, not just in the column's name.
 */
export class TicketNumberSequence1797300000001 implements MigrationInterface {
  name = 'TicketNumberSequence1797300000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE SEQUENCE ticket_number_seq');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP SEQUENCE ticket_number_seq');
  }
}
