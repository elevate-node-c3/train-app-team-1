import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryRunner } from 'typeorm';
import {
  EnforcePassengerLimitAndTypes1761314900000,
  migrations,
  IDENTITY_MIGRATIONS,
} from './index.js';

describe('EnforcePassengerLimitAndTypes1761314900000', () => {
  let migration: EnforcePassengerLimitAndTypes1761314900000;
  let queryRunner: {
    query: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    migration = new EnforcePassengerLimitAndTypes1761314900000();
    queryRunner = {
      query: vi.fn().mockResolvedValue([]),
    };
  });

  it('is exported in migrations and IDENTITY_MIGRATIONS arrays', () => {
    expect(migrations).toContain(EnforcePassengerLimitAndTypes1761314900000);
    expect(IDENTITY_MIGRATIONS).toContain(EnforcePassengerLimitAndTypes1761314900000);
  });

  it('has correct migration name timestamp matching class', () => {
    expect(migration.name).toBe('EnforcePassengerLimitAndTypes1761314900000');
  });

  describe('up', () => {
    it('creates function check_passenger_limit_trigger, creates trigger trg_passenger_limit, and updates profile_type', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledTimes(3);

      const queries = queryRunner.query.mock.calls.map((call) => call[0] as string);

      // 1. Function check_passenger_limit_trigger
      expect(queries[0]).toContain('CREATE OR REPLACE FUNCTION check_passenger_limit_trigger()');
      expect(queries[0]).toContain('RETURNS TRIGGER');
      expect(queries[0]).toContain('IF NEW.is_self = false THEN');
      expect(queries[0]).toContain('SELECT COUNT(*) INTO companion_count');
      expect(queries[0]).toContain('FROM passenger');
      expect(queries[0]).toContain('WHERE account_id = NEW.account_id AND is_self = false AND id != NEW.id');
      expect(queries[0]).toContain('IF companion_count >= 10 THEN');
      expect(queries[0]).toContain("RAISE EXCEPTION 'PASSENGER_LIMIT_REACHED'");
      expect(queries[0]).toContain("USING ERRCODE = 'check_violation'");
      expect(queries[0]).toContain("MESSAGE = 'Account companion passenger limit of 10 reached'");

      // 2. Trigger trg_passenger_limit
      expect(queries[1]).toContain('CREATE TRIGGER trg_passenger_limit');
      expect(queries[1]).toContain('BEFORE INSERT OR UPDATE ON passenger');
      expect(queries[1]).toContain('FOR EACH ROW');
      expect(queries[1]).toContain('EXECUTE FUNCTION check_passenger_limit_trigger()');

      // 3. Update profile_type Regular to كوامل
      expect(queries[2]).toContain('UPDATE profile_type');
      expect(queries[2]).toContain("SET name_ar = 'كوامل'");
      expect(queries[2]).toContain("WHERE code = 'Regular'");
    });
  });

  describe('down', () => {
    it('drops trigger, drops function, and reverts profile_type name_ar', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledTimes(3);

      const queries = queryRunner.query.mock.calls.map((call) => call[0] as string);

      // 1. Drop trigger
      expect(queries[0]).toContain('DROP TRIGGER IF EXISTS trg_passenger_limit ON passenger');

      // 2. Drop function
      expect(queries[1]).toContain('DROP FUNCTION IF EXISTS check_passenger_limit_trigger()');

      // 3. Revert profile_type
      expect(queries[2]).toContain('UPDATE profile_type');
      expect(queries[2]).toContain("SET name_ar = 'عادي'");
      expect(queries[2]).toContain("WHERE code = 'Regular'");
    });
  });
});
