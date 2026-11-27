import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  closePaymentDataSource,
  paymentDataSource,
} from './support/payment-database.js';

type ProcessedEventColumn = {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
};

type ProcessedEventSchema = {
  table: boolean;
  columns: ProcessedEventColumn[];
  checks: string[];
  index: string | null;
};

async function schema(source: DataSource): Promise<ProcessedEventSchema> {
  const tables: { table_name: string }[] = await source.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'processed_event'`,
  );
  if (!tables.length) {
    return { table: false, columns: [], checks: [], index: null };
  }

  const columns: ProcessedEventColumn[] = await source.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'processed_event'
      ORDER BY ordinal_position`,
  );
  const rows: { expression: string }[] = await source.query(
    `SELECT pg_get_expr(conbin, conrelid) AS expression
       FROM pg_constraint
      WHERE conrelid = 'processed_event'::regclass AND contype = 'c'`,
  );
  const indexes: { indexdef: string }[] = await source.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'processed_event'
        AND indexname = 'idx_processed_event_processing'`,
  );

  return {
    table: true,
    columns,
    checks: rows.map((row) => row.expression.replace(/\s+/g, ' ').trim()),
    index: indexes[0]?.indexdef ?? null,
  };
}

function expectApplied(actual: ProcessedEventSchema): void {
  expect(actual.table).toBe(true);
  expect(actual.columns).toEqual([
    { column_name: 'event_id', data_type: 'uuid', is_nullable: 'NO' },
    { column_name: 'event_type', data_type: 'text', is_nullable: 'NO' },
    { column_name: 'status', data_type: 'text', is_nullable: 'NO' },
    { column_name: 'attempt_count', data_type: 'integer', is_nullable: 'NO' },
    {
      column_name: 'claimed_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
    },
    {
      column_name: 'handled_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    },
    { column_name: 'skip_reason', data_type: 'text', is_nullable: 'YES' },
    { column_name: 'last_error', data_type: 'text', is_nullable: 'YES' },
    {
      column_name: 'created_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
    },
  ]);
  expect(actual.checks).toEqual(
    expect.arrayContaining([
      "(attempt_count > 0)",
      "(status = ANY (ARRAY['processing'::text, 'handled'::text, 'skipped'::text, 'failed'::text]))",
    ]),
  );
  expect(actual.index).toContain(
    'CREATE INDEX idx_processed_event_processing ON public.processed_event USING btree (claimed_at) WHERE (status = \'processing\'::text)',
  );
}

function expectAbsent(actual: ProcessedEventSchema): void {
  expect(actual).toEqual({
    table: false,
    columns: [],
    checks: [],
    index: null,
  });
}

describe('TA-109 payment processed-event migration (real PostgreSQL)', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await paymentDataSource();
  });

  afterAll(async () => {
    await closePaymentDataSource();
  });

  it('applies, rolls back, and reapplies cleanly', async () => {
    expectApplied(await schema(source));

    await source.undoLastMigration();
    expectAbsent(await schema(source));

    await source.runMigrations();
    expectApplied(await schema(source));
  });
});
