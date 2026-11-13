import { describe, it, expect } from 'vitest';
import { inventoryDataSource } from './support/inventory-database.js';

describe('inventory migrations', () => {
  it('creates the outbox and inbox tables', async () => {
    const source = await inventoryDataSource();
    const rows: { table_name: string }[] = await source.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [['outbox_event', 'processed_event']],
    );
    expect(rows.map((r) => r.table_name)).toEqual(['outbox_event', 'processed_event']);
  });

  it('indexes only unpublished outbox rows', async () => {
    const source = await inventoryDataSource();
    const rows: { indexdef: string }[] = await source.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_outbox_event_unpublished'`,
    );
    expect(rows[0].indexdef).toContain('WHERE (published_at IS NULL)');
  });
});
