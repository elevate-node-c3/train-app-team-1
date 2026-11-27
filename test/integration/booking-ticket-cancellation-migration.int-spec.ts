import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  bookingDataSource,
  closeBookingDataSource,
} from './support/booking-database.js';

const INDEX_NAME = 'ticket_cancellation_idempotency_key_idx';

type TicketColumn = {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
};

type CancellationIndex = {
  columns: string[];
  predicate: string | null;
  unique: boolean;
};

async function ticketColumns(source: DataSource): Promise<TicketColumn[]> {
  return source.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'ticket'
        AND column_name IN (
          'refund_status', 'refund_piastres', 'cancellation_idempotency_key'
        )
      ORDER BY column_name`,
  );
}

async function cancellationIndex(
  source: DataSource,
): Promise<CancellationIndex | undefined> {
  const [row]: {
    columns: string[];
    predicate: string | null;
    unique: boolean;
  }[] = await source.query(
    `SELECT ARRAY(
               SELECT pg_get_indexdef(i.indexrelid, k.position, true)
                 FROM generate_series(1, i.indnkeyatts) AS k(position)
                ORDER BY k.position
             ) AS columns,
             pg_get_expr(i.indpred, i.indrelid) AS predicate,
             i.indisunique AS unique
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND t.relname = 'ticket'
         AND c.relname = $1`,
    [INDEX_NAME],
  );
  if (!row) return undefined;

  // Postgres deparses predicates with cosmetic parentheses and quotes.
  return {
    columns: row.columns,
    predicate:
      row.predicate?.replace(/[()"]/g, '').replace(/\s+/g, ' ').trim() ?? null,
    unique: row.unique,
  };
}

function expectApplied(
  columns: TicketColumn[],
  index: CancellationIndex | undefined,
): void {
  expect(columns).toEqual([
    {
      column_name: 'cancellation_idempotency_key',
      data_type: 'text',
      is_nullable: 'YES',
    },
    {
      column_name: 'refund_piastres',
      data_type: 'integer',
      is_nullable: 'YES',
    },
    {
      column_name: 'refund_status',
      data_type: 'character varying',
      is_nullable: 'YES',
    },
  ]);
  expect(index).toEqual({
    columns: ['cancellation_idempotency_key'],
    predicate: 'cancellation_idempotency_key IS NOT NULL',
    unique: true,
  });
}

function expectAbsent(
  columns: TicketColumn[],
  index: CancellationIndex | undefined,
): void {
  expect(columns).toEqual([]);
  expect(index).toBeUndefined();
}

describe('TA-109 ticket cancellation migration (real PostgreSQL)', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await bookingDataSource();
  });

  afterAll(async () => {
    await closeBookingDataSource();
  });

  it('applies, rolls back, and reapplies cleanly', async () => {
    expectApplied(await ticketColumns(source), await cancellationIndex(source));

    await source.undoLastMigration();
    expectAbsent(await ticketColumns(source), await cancellationIndex(source));

    await source.runMigrations();
    expectApplied(await ticketColumns(source), await cancellationIndex(source));
  });
});
