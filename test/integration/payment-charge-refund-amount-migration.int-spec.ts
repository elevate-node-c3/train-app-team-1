import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  closePaymentDataSource,
  paymentDataSource,
} from './support/payment-database.js';

type RefundAmountColumn = {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
};

async function refundAmountColumns(
  source: DataSource,
): Promise<RefundAmountColumn[]> {
  return source.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'payment_charge'
        AND column_name = 'refund_amount_piastres'`,
  );
}

function expectApplied(columns: RefundAmountColumn[]): void {
  expect(columns).toEqual([
    {
      column_name: 'refund_amount_piastres',
      data_type: 'integer',
      is_nullable: 'YES',
    },
  ]);
}

function expectAbsent(columns: RefundAmountColumn[]): void {
  expect(columns).toEqual([]);
}

describe('TA-109 payment charge refund amount migration (real PostgreSQL)', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await paymentDataSource();
  });

  afterAll(async () => {
    await closePaymentDataSource();
  });

  it('applies, rolls back, and reapplies cleanly', async () => {
    expectApplied(await refundAmountColumns(source));

    await source.undoLastMigration();
    expectAbsent(await refundAmountColumns(source));

    await source.runMigrations();
    expectApplied(await refundAmountColumns(source));
  });
});
