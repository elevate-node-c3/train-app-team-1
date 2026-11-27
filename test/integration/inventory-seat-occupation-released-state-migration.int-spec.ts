import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  closeInventoryDataSource,
  inventoryDataSource,
} from './support/inventory-database.js';

/** The CHECK's deparsed expression, without depending on Task 3's table shape. */
async function stateCheck(source: DataSource): Promise<string> {
  const [row]: { expression: string }[] = await source.query(
    `SELECT pg_get_expr(conbin, conrelid) AS expression
       FROM pg_constraint
      WHERE conrelid = 'seat_occupation'::regclass
        AND conname = 'chk_seat_occupation_state'`,
  );
  return row?.expression ?? '';
}

function expectReleasedAllowed(expression: string): void {
  expect(expression).toContain('held');
  expect(expression).toContain('sold');
  expect(expression).toContain('released');
}

function expectReleasedRejected(expression: string): void {
  expect(expression).toContain('held');
  expect(expression).toContain('sold');
  expect(expression).not.toContain('released');
}

describe('TA-109 inventory released-state migration (real PostgreSQL)', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await inventoryDataSource();
  });

  afterAll(async () => {
    await closeInventoryDataSource();
  });

  it('applies, rolls back, and reapplies cleanly', async () => {
    expectReleasedAllowed(await stateCheck(source));

    await source.undoLastMigration();
    expectReleasedRejected(await stateCheck(source));

    await source.runMigrations();
    expectReleasedAllowed(await stateCheck(source));
  });
});
