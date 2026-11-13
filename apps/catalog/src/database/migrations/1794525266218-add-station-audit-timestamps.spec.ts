import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { migrations } from './index.js';
import { AddStationAuditTimestamps1794525266218 } from './1794525266218-add-station-audit-timestamps.js';

describe('station audit timestamps forward migration', () => {
  it('adds audit columns to all station tables without recreating or clearing them', async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    await new AddStationAuditTimestamps1794525266218().up({
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('ALTER TABLE "governorate"'),
      expect.stringContaining('ALTER TABLE "city"'),
      expect.stringContaining('ALTER TABLE "station"'),
    ]);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain(
        'ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()',
      );
      expect(sql).toContain(
        'ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()',
      );
      expect(sql).not.toMatch(/CREATE TABLE|DROP TABLE|DELETE FROM|TRUNCATE/);
    }
  });

  it('reverts only the audit columns, leaving the tables intact', async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    await new AddStationAuditTimestamps1794525266218().down({
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('DROP COLUMN IF EXISTS "updated_at"');
      expect(sql).toContain('DROP COLUMN IF EXISTS "created_at"');
      expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/);
    }
  });

  it('keeps one station creation migration and runs the timestamp migration last', () => {
    const names = migrations.map((Migration) => new Migration().name);
    expect(
      names.filter((name) => name?.startsWith('CreateStationCatalog')),
    ).toEqual(['CreateStationCatalog1793292475941']);
    expect(names.at(-1)).toBe('AddStationAuditTimestamps1794525266218');
  });
});
